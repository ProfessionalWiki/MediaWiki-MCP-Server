#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import express, {
	type ErrorRequestHandler,
	type RequestHandler,
	type Request,
	type Response,
} from 'express';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
	hostHeaderValidation,
	localhostHostValidation,
	originValidation,
} from '@modelcontextprotocol/express';
import { evaluateBearerGuard } from './bearerGuard.js';
import { hasStaticCredentials } from '../runtime/authShape.js';
import { LOCALHOST_HOSTS, resolveHttpConfig } from './httpConfig.js';
import { logger } from '../runtime/logger.js';
import {
	getMetricsHandler,
	initMetrics,
	isMetricsEnabled,
	setSessionsProvider,
	setProxyStoreStatsProvider,
} from '../runtime/metrics.js';
import { withRequestContext } from '../runtime/requestContext.js';
import { createInFlightCounter, type InFlightCounter } from './inFlight.js';
import { markSessionActive, markSessionIdle, type SessionRegistry } from './sessionRegistry.js';
import { mountReadyEndpoint } from './ready.js';
import { loadConfigFromFile, type WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import { fetchMetadata, type UpstreamAsMetadata } from '../auth/metadata.js';
import { buildProtectedResource, resolvePublicBase } from '../auth/protectedResource.js';
import { resolveProxyConfig, type ProxyConfig } from '../auth/authorizationServer/proxyConfig.js';
import type { ProxyStore } from '../auth/authorizationServer/proxyStore.js';
import {
	resolveUpstreamBearer,
	UpstreamBearerError,
	type RefreshFn,
} from '../auth/upstreamBearer.js';
import { createProxyStore } from '../auth/authorizationServer/proxyStorePersistence.js';
import { mountAuthorizationServer } from '../auth/authorizationServer/router.js';
import { buildRedirectPolicy } from '../auth/authorizationServer/redirectPolicy.js';
import { buildCimdHostPredicate, CimdResolver } from '../auth/authorizationServer/cimd.js';
import { fetchCimdDocument } from './cimdFetch.js';
import { createAppState, type AppState } from '../wikis/state.js';
import { createServer } from '../server.js';
import { emitStartupBanner } from '../runtime/banner.js';
import { createToolContext } from '../runtime/createContext.js';
import { registerShutdownHandlers, resolveShutdownGrace } from '../runtime/shutdown.js';

export function extractBearerToken(req: Request): string | undefined {
	const raw = req.headers.authorization;
	if (typeof raw !== 'string') {
		return undefined;
	}
	const first = raw.split(',')[0].trim();
	if (!first.toLowerCase().startsWith('bearer ')) {
		return undefined;
	}
	const token = first.slice(7).trim();
	return token || undefined;
}

export function resolveMcpHostValidation(
	host: string,
	allowedHosts: string[] | undefined,
): RequestHandler | undefined {
	if (allowedHosts) {
		return hostHeaderValidation(allowedHosts);
	}
	if (LOCALHOST_HOSTS.includes(host)) {
		return localhostHostValidation();
	}
	if (host === '0.0.0.0' || host === '::') {
		logger.warning(
			`Server is binding to ${host} without a Host-header allowlist. ` +
				'Set MCP_ALLOWED_HOSTS to restrict allowed Host-header values, ' +
				'or use authentication to protect your server.',
		);
	}
	return undefined;
}

// Reduces one configured value to the hostname the Origin middleware compares
// against. Three spellings have to work: a full origin, a bare hostname, and a
// `host:port` pair. Only the first parses as a URL on its own — a bare hostname
// throws, and `host:port` is worse, parsing as a scheme with an opaque path and
// yielding an EMPTY hostname rather than throwing. Retrying behind `https://`
// covers both, and has the side benefit of punycoding an internationalised name,
// which is the form a browser actually sends in the Origin header.
function hostnameOf(value: string): string | undefined {
	try {
		const { hostname } = new URL(value);
		if (hostname !== '') {
			return hostname;
		}
	} catch {
		// Not a URL on its own; it may still be a bare hostname or host:port.
	}
	// Only retry a value that carries no scheme of its own. Prefixing one that
	// already has a scheme would read the hostname back out of the scheme itself,
	// turning the malformed `https://` into the hostname `https`. A `host:port`
	// pair has no `//`, so this still lets that case through to the retry.
	if (value.includes('://')) {
		return undefined;
	}
	try {
		const { hostname } = new URL(`https://${value}`);
		return hostname === '' ? undefined : hostname;
	} catch {
		return undefined;
	}
}

// MCP_ALLOWED_ORIGINS is configured as full origins (`https://wiki.example.org`),
// but the SDK's Origin middleware matches on hostname alone. Reduce each entry to
// its hostname so existing configuration keeps working untouched. IPv6 keeps its
// brackets (`[::1]`), which is the form the middleware expects. An entry nothing
// can be read from is dropped with a warning rather than poisoning the allowlist
// with a value no Origin header could ever match.
export function toOriginHostnames(allowedOrigins: readonly string[]): string[] {
	const hostnames = new Set<string>();
	const unusable: string[] = [];
	for (const entry of allowedOrigins) {
		const trimmed = entry.trim();
		if (trimmed === '') {
			continue;
		}
		const hostname = hostnameOf(trimmed);
		if (hostname === undefined) {
			unusable.push(trimmed);
			continue;
		}
		hostnames.add(hostname);
	}
	if (unusable.length > 0) {
		logger.warning(
			`Ignoring unreadable MCP_ALLOWED_ORIGINS ${unusable.length === 1 ? 'entry' : 'entries'}: ` +
				`${unusable.join(', ')}. Expected an origin (https://wiki.example.org), ` +
				'a hostname, or host:port.',
		);
	}
	return [...hostnames];
}

// Builds the Origin guard. See buildApp for why it is attached per route rather
// than mounted on the /mcp prefix. An absent allowlist leaves validation off,
// which is the policy the transport option this replaced also applied.
export function resolveMcpOriginValidation(
	allowedOrigins: string[] | undefined,
): RequestHandler | undefined {
	if (!allowedOrigins) {
		return undefined;
	}
	const hostnames = toOriginHostnames(allowedOrigins);
	if (hostnames.length === 0) {
		// An allowlist was configured but nothing in it survived parsing. Say so:
		// turning a control off because its configuration was unreadable must not
		// be silent, and the unset-allowlist warning in buildApp does not fire for
		// an array that was non-empty to begin with.
		logger.warning(
			'MCP_ALLOWED_ORIGINS is set but no usable hostname could be read from it, ' +
				'so Origin validation is disabled. Correct the values or unset the variable.',
		);
		return undefined;
	}
	return originValidation(hostnames);
}

// Handles a fatal error from app.listen — a failed bind (EADDRINUSE / EACCES) or
// any other listen error. The 'error' event fires asynchronously after
// startHttpServer() has returned, so index.ts's main().catch cannot catch it and,
// with no listener registered, a net.Server 'error' event would surface as an
// uncaught exception with a raw stack trace. Log a clear, actionable message and
// terminate. onFatal is injectable so tests can assert the message without exiting
// the test process.
export function handleListenError(
	err: NodeJS.ErrnoException,
	host: string,
	port: number,
	onFatal: (code: number) => void = (code) => process.exit(code),
): void {
	if (err.code === 'EADDRINUSE') {
		logger.error(`Cannot start HTTP server: ${host}:${port} is already in use.`);
	} else if (err.code === 'EACCES') {
		logger.error(`Cannot start HTTP server: permission denied binding ${host}:${port}.`);
	} else {
		logger.error(`HTTP server failed to start on ${host}:${port}: ${err.message}`);
	}
	onFatal(1);
}

// Returns the active hosted-OAuth-proxy config, or null when the proxy is
// disabled. getDefaultProxyConfig (below) is the production implementation.
export type ProxyConfigGetter = () => ProxyConfig | null;

export function createOAuthProtectedResourceHandler(deps: {
	wikiRegistry: WikiRegistry;
	// When the hosted OAuth proxy is enabled, this server is itself the
	// authorization server, so the protected-resource doc must advertise the
	// proxy issuer (self) rather than the per-wiki upstream issuers.
	getProxyConfig?: ProxyConfigGetter;
}): RequestHandler {
	return async (req, res, next) => {
		try {
			const wikis = deps.wikiRegistry.getAll();
			const oauthWikis = Object.entries(wikis).filter(
				([, w]) => typeof w.oauth2ClientId === 'string' && w.oauth2ClientId.trim() !== '',
			);
			if (oauthWikis.length === 0) {
				res.status(404).end();
				return;
			}
			const settled = await Promise.allSettled(
				oauthWikis.map(([key, cfg]) =>
					fetchMetadata(key, { server: cfg.server, scriptpath: cfg.scriptpath }),
				),
			);
			const metadatas = settled
				.filter((r): r is PromiseFulfilledResult<UpstreamAsMetadata> => r.status === 'fulfilled')
				.map((r) => r.value);
			if (metadatas.length === 0) {
				const reasons = settled
					.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
					.map((r) => String(r.reason));
				logger.warning('OAuth protected-resource discovery failed for all wikis', {
					reasons,
				});
				res.status(503).json({ error: 'discovery_failed' });
				return;
			}
			const requestProto = resolveRequestProto(req);
			const proxyConfig = deps.getProxyConfig?.() ?? null;
			const doc = buildProtectedResource({
				wikis,
				metadatas,
				requestHost: req.headers.host ?? undefined,
				requestProto,
				authorizationServersOverride: proxyConfig ? [proxyConfig.issuer] : undefined,
			});
			if (!doc) {
				res.status(404).end();
				return;
			}
			res.json(doc);
		} catch (err) {
			next(err);
		}
	};
}

// Resolves the request's scheme, honouring a trusted reverse proxy's
// x-forwarded-proto (first value) and falling back to the socket's own security.
function resolveRequestProto(req: Request): 'http' | 'https' {
	const protoHeader = req.headers['x-forwarded-proto'];
	const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() : undefined;
	return proto === 'https' || proto === 'http' ? proto : req.secure ? 'https' : 'http';
}

// A wiki needs auth when it is OAuth-only with no usable static fallback.
function wikiNeedsAuth(cfg: WikiConfig, fallbackAllowed: boolean): boolean {
	const oauthOnly = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
	if (!oauthOnly) {
		return false;
	}
	const hasStatic = hasStaticCredentials(cfg);
	return !(hasStatic && fallbackAllowed);
}

export interface McpPostHandlerOptions {
	wikiRegistry?: WikiRegistry;
	idleTimeoutMs?: number;
	// When the hosted OAuth proxy is enabled, the /mcp bearer is a proxy-minted
	// JWT (not a wiki token): we verify it and resolve the upstream wiki token
	// from the store before threading it into withRequestContext. Omitted (or
	// returning null) leaves the legacy bearer-passthrough/401-discovery path
	// unchanged.
	getProxyConfig?: ProxyConfigGetter;
	proxyStore?: ProxyStore;
	// Injected for testing; production leaves it undefined so resolveUpstreamBearer
	// uses the real server-to-server refresh.
	refresh?: RefreshFn;
	// The default wiki served by this transport. When that wiki is configured
	// `private` (anonymous reads disabled upstream), a tokenless request is
	// challenged with a connection-time 401 rather than served anonymously.
	defaultWikiKey?: string;
}

// Emits the shared OAuth 401 challenge: a JSON-RPC error body with the
// WWW-Authenticate: Bearer ... resource_metadata=... header pointing at this
// server's protected-resource document. Reused by the legacy OAuth-only
// short-circuit and the proxy invalid-JWT path so both speak the same dialect.
function emit401Challenge(req: Request, res: Response): void {
	const requestProto = resolveRequestProto(req);
	const base = resolvePublicBase(req.headers.host ?? undefined, requestProto);
	// The protected-resource document is served at the ORIGIN root (RFC 9728), not
	// under MCP_PUBLIC_URL's path segment. Point resource_metadata at the origin so
	// it resolves — the SDK fetches this URL verbatim with no root fallback. Preserve
	// the authority (including any explicit port) and only drop a trailing path.
	const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(base)?.[0] ?? base.replace(/\/+$/, '');
	const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
	res.set(
		'WWW-Authenticate',
		`Bearer error="invalid_token", realm="MediaWiki MCP Server", resource_metadata="${metadataUrl}"`,
	);
	res.status(401).json({
		jsonrpc: '2.0',
		error: {
			code: -32001,
			message: 'Authentication required. See WWW-Authenticate header.',
		},
		id: null,
	});
}

// Emitted when a proxy JWT is valid but its upstream token could not be refreshed
// because of a transient upstream failure. Unlike emit401Challenge this carries NO
// WWW-Authenticate header: the client should retry, not discard its session and
// re-authenticate.
function emit503Unavailable(res: Response): void {
	res.status(503).json({
		jsonrpc: '2.0',
		error: {
			code: -32000,
			message: 'Upstream authorization temporarily unavailable. Please retry.',
		},
		id: null,
	});
}

export function createMcpPostHandler(
	sessions: SessionRegistry,
	createServerFn: () => ReturnType<typeof createServer>,
	options: McpPostHandlerOptions = {},
): RequestHandler {
	const {
		wikiRegistry,
		idleTimeoutMs = 0,
		getProxyConfig,
		proxyStore,
		refresh,
		defaultWikiKey,
	} = options;
	return async (req, res) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Express headers are string|string[]|undefined; MCP transport sends a single header
		const sessionId = req.headers['mcp-session-id'] as string | undefined;
		const bearer = extractBearerToken(req);

		// A `private` wiki disallows anonymous reads, so the deployment requires
		// auth for everything: challenge any tokenless request up front — including
		// `initialize` — so an OAuth-capable client signs in at connect. This
		// connection-time 401 is the broadly client-compatible trigger.
		if (
			!bearer &&
			defaultWikiKey !== undefined &&
			wikiRegistry?.get(defaultWikiKey)?.private === true
		) {
			emit401Challenge(req, res);
			return;
		}

		const pc = getProxyConfig?.() ?? null;

		// The token threaded into withRequestContext (and thus into mwn). For the
		// legacy path it is the raw request bearer. For the proxy path it is the
		// UPSTREAM wiki token resolved from the proxy JWT (or undefined for an
		// anonymous, tokenless request).
		let resolvedBearer = bearer;

		if (pc && proxyStore) {
			// Proxy enabled. A bearer is a proxy JWT: verify + resolve it to the
			// upstream wiki token. A 401 (with the discovery hint) is emitted only
			// when a bearer is present but invalid/expired/unresolvable — never for a
			// tokenless request, which is served anonymously (step-up for write tools
			// happens later in checkWikiCapability, not as a transport 401).
			if (bearer) {
				try {
					resolvedBearer = await resolveUpstreamBearer(bearer, pc, proxyStore, refresh);
				} catch (err) {
					// A transient upstream refresh failure is retryable: answer 503 without a
					// re-auth challenge. Everything else (bad/expired JWT, dead refresh token)
					// is a genuine auth failure: emit the 401 discovery challenge.
					if (err instanceof UpstreamBearerError && err.retryable) {
						emit503Unavailable(res);
					} else {
						emit401Challenge(req, res);
					}
					return;
				}
			} else {
				resolvedBearer = undefined;
			}
		} else if (!bearer && wikiRegistry) {
			// Legacy (proxy disabled): a tokenless request to a set of wikis that all
			// require OAuth is rejected up front with the discovery challenge. This
			// path is intentionally left UNCHANGED.
			const all = Object.values(wikiRegistry.getAll());
			const fallbackAllowed = process.env.MCP_ALLOW_STATIC_FALLBACK === 'true';
			const allNeedAuth = all.length > 0 && all.every((cfg) => wikiNeedsAuth(cfg, fallbackAllowed));
			if (allNeedAuth) {
				emit401Challenge(req, res);
				return;
			}
		}
		let transport: NodeStreamableHTTPServerTransport;

		if (sessionId && sessions[sessionId]) {
			transport = sessions[sessionId].transport;
			// Existing session: the registry entry already exists, so count this
			// request now and release it when the response closes.
			markSessionActive(sessions, sessionId);
		} else if (!sessionId && isInitializeRequest(req.body)) {
			transport = new NodeStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				// Host-header and Origin validation both run as Express middleware
				// upstream of this handler, so no DNS-rebinding options are passed
				// here — the transport's own copies are deprecated in favour of
				// exactly that arrangement.
				// onsessioninitialized fires during handleRequest below — the only
				// point where the registry entry and transport.sessionId both
				// exist. Seed activeRequests to 1 so the init POST counts as
				// in-flight; the res.on('close') handler registered after
				// handleRequest releases it.
				onsessioninitialized: (newSessionId) => {
					sessions[newSessionId] = { transport, activeRequests: 1 };
				},
			});

			transport.onclose = () => {
				if (transport.sessionId) {
					const entry = sessions[transport.sessionId];
					if (entry?.idleTimer) {
						clearTimeout(entry.idleTimer);
					}
					delete sessions[transport.sessionId];
				}
			};
			const server = await createServerFn();

			await server.connect(transport);
		} else {
			res.status(400).json({
				jsonrpc: '2.0',
				error: {
					code: -32000,
					message: 'Bad Request: No valid session ID provided',
				},
				id: null,
			});
			return;
		}

		// Release the in-flight count when this response closes. transport.sessionId
		// is populated by now for both branches (set synchronously during
		// handleRequest for a new session). Registered before handleRequest so the
		// 'close' listener is in place even if the response finishes synchronously.
		res.on('close', () => {
			const sid = transport.sessionId;
			if (sid) {
				markSessionIdle(sessions, sid, idleTimeoutMs);
			}
		});

		await withRequestContext(resolvedBearer, transport.sessionId, () =>
			transport.handleRequest(req, res, req.body),
		);
	};
}

export function createSessionRequestHandler(
	sessions: SessionRegistry,
	idleTimeoutMs = 0,
	wikiRegistry?: WikiRegistry,
	defaultWikiKey?: string,
): RequestHandler {
	return async (req, res) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Express headers are string|string[]|undefined; MCP transport sends a single header
		const sessionId = req.headers['mcp-session-id'] as string | undefined;
		const bearer = extractBearerToken(req);

		// A `private` deployment never serves a tokenless request — including the
		// standalone GET SSE stream and DELETE.
		if (
			!bearer &&
			defaultWikiKey !== undefined &&
			wikiRegistry?.get(defaultWikiKey)?.private === true
		) {
			emit401Challenge(req, res);
			return;
		}

		if (!sessionId || !sessions[sessionId]) {
			res.status(400).send('Invalid or missing session ID');
			return;
		}
		// A held-open GET SSE stream stays counted as active until it closes, so
		// markSessionIdle (and the idle timer) won't run while a client holds it.
		markSessionActive(sessions, sessionId);
		res.on('close', () => markSessionIdle(sessions, sessionId, idleTimeoutMs));

		const entry = sessions[sessionId];
		// The session id (a 122-bit randomUUID) is itself the session capability:
		// possession of a valid one authorizes GET/DELETE, with no bearer check.
		// That is safe because every POST self-authenticates with its own per-
		// request bearer (results return on that POST's own HTTP response), and
		// the standalone GET SSE stream carries only global, non-client-specific
		// notifications — so a session id alone grants nothing sensitive.
		// The bearer is still extracted to thread into withRequestContext for
		// consistency with the POST path.
		await withRequestContext(bearer, sessionId, () => entry.transport.handleRequest(req, res));
	};
}

// body-parser raises a PayloadTooLargeError with `type === 'entity.too.large'`
// when the request body exceeds the configured limit. Without this handler the
// default Express error page returns an HTML blob, which an MCP client cannot
// parse — so we shape it as a JSON-RPC error.
export function payloadTooLargeHandler(limit: string): ErrorRequestHandler {
	return (err, _req, res, next) => {
		const tooLarge =
			typeof err === 'object' &&
			err !== null &&
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- predicate body's required cast to inspect body-parser PayloadTooLargeError
			(err as { type?: unknown }).type === 'entity.too.large';
		if (!tooLarge) {
			next(err);
			return;
		}
		res.status(413).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: `Request body exceeds the configured maximum size of ${limit}`,
			},
			id: null,
		});
	};
}

export function mountMetricsEndpoint(app: express.Express): void {
	if (!isMetricsEnabled()) {
		return;
	}
	initMetrics();
	const handler = getMetricsHandler();
	if (handler) {
		app.get('/metrics', handler);
	}
}

// The HTTP server's boot — config load, the static-credentials guard, proxy-
// infrastructure construction, route wiring, and app.listen — lives in
// startHttpServer() at the bottom of this module. Importing this module has no
// side effects; index.ts calls startHttpServer() for the `http` transport, and
// tests import the pure factory/helpers without booting a server.

// Everything buildApp needs that startHttpServer resolves from config/env.
// Extracting these into an explicit deps object lets the end-to-end test mount
// the REAL routes against a fake authorization server (with a proxy config whose
// upstream base is only known at runtime), without running startHttpServer (no
// app.listen, no process.exit guard, no encrypted-store hydration).
export interface BuildAppDeps {
	state: AppState;
	getProxyConfig: ProxyConfigGetter;
	proxyStore: ProxyStore;
	// The register-time redirect predicate, built once from the resolved proxy
	// config (built-ins + operator allowlist). Null when the proxy is disabled,
	// in which case /mcp/register 404s alongside the other proxy endpoints.
	proxyRedirectPolicy: ((uri: string) => boolean) | null;
	// The CIMD client resolver, built once from the resolved proxy config. Null when
	// the proxy is disabled. Resolves a URL client_id into a ClientRecord by fetching
	// its metadata document (DCR clients keep using the store).
	cimdResolver: CimdResolver | null;
	// The default wiki KEY (bound into the consent cookie) and human-readable
	// sitename (shown on the consent page). Match getProxyConfig's wiki.
	defaultWikiKey: string;
	defaultWikiSitename: string;
	createServerFn: () => ReturnType<typeof createServer>;
	host: string;
	allowedHosts?: string[];
	allowedOrigins?: string[];
	maxRequestBody: string;
	sessionIdleTimeoutMs: number;
}

export interface BuiltApp {
	app: express.Express;
	sessions: SessionRegistry;
	inFlight: InFlightCounter;
}

// Builds the HTTP transport's Express app and all its routes. Pure with respect
// to its deps: no app.listen, no process.exit, no config/env reads beyond what
// the deps carry. startHttpServer (bottom of this module) resolves the deps and
// calls this; the end-to-end test calls it directly with a fake-AS-backed proxy
// config so it can drive the real OAuth-proxy routes.
export function buildApp(deps: BuildAppDeps): BuiltApp {
	const {
		state,
		getProxyConfig,
		proxyStore: store,
		proxyRedirectPolicy,
		cimdResolver,
		defaultWikiKey,
		defaultWikiSitename,
		createServerFn,
		host,
		allowedHosts,
		allowedOrigins,
		maxRequestBody,
		sessionIdleTimeoutMs,
	} = deps;

	// A `private` wiki challenges anonymous callers with a 401 whose discovery
	// document only resolves to an authorization server when the wiki has an
	// `oauth2ClientId`. Warn the operator about a private wiki that lacks one.
	for (const [key, cfg] of Object.entries(state.wikiRegistry.getAll())) {
		const hasAs = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
		if (cfg.private === true && !hasAs) {
			logger.warning(
				`Wiki "${key}" is marked private but has no oauth2ClientId; anonymous clients ` +
					'will be challenged with a 401 pointing at an authorization server the wiki does ' +
					'not advertise. Configure an OAuth2 consumer or unset `private`.',
			);
		}
	}

	const app = express();
	app.use(express.json({ limit: maxRequestBody }));
	app.use(payloadTooLargeHandler(maxRequestBody));

	const hostValidation = resolveMcpHostValidation(host, allowedHosts);
	if (hostValidation) {
		app.use('/mcp', hostValidation);
	}

	// Attached per route below rather than with app.use('/mcp', …), which would
	// prefix-match and so also guard the authorization-server endpoints mounted
	// under /mcp/register, /mcp/authorize, /mcp/consent, /mcp/oauth/callback and
	// /mcp/token. Those are browser-facing: the consent form POSTs from the
	// server's OWN origin, which an operator listing only their client origins
	// would not have allowlisted, and the sign-in would 403 at the Approve click.
	// Host-header validation above is prefix-mounted on purpose — it matches the
	// server's own hostname, so it is correct for every route under /mcp.
	const originCheck = resolveMcpOriginValidation(allowedOrigins);
	const mcpOriginGuard: RequestHandler[] = originCheck ? [originCheck] : [];

	if ((host === '0.0.0.0' || host === '::') && !allowedOrigins) {
		logger.warning(
			`Server is binding to ${host} without an Origin allowlist. ` +
				'Set MCP_ALLOWED_ORIGINS to restrict allowed Origin-header values, ' +
				'or front the server with a reverse proxy that enforces Origin.',
		);
	}

	const sessions: SessionRegistry = {};
	const sessionRequestHandler = createSessionRequestHandler(
		sessions,
		sessionIdleTimeoutMs,
		state.wikiRegistry,
		defaultWikiKey,
	);

	const inFlight = createInFlightCounter();
	app.use('/mcp', inFlight.middleware);

	app.post(
		'/mcp',
		...mcpOriginGuard,
		createMcpPostHandler(sessions, createServerFn, {
			wikiRegistry: state.wikiRegistry,
			idleTimeoutMs: sessionIdleTimeoutMs,
			getProxyConfig,
			proxyStore: store,
			defaultWikiKey,
		}),
	);
	app.get('/mcp', ...mcpOriginGuard, sessionRequestHandler);
	app.delete('/mcp', ...mcpOriginGuard, sessionRequestHandler);

	app.get('/health', (_req: Request, res: Response) => {
		res.status(200).json({ status: 'ok' });
	});

	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({
			wikiRegistry: state.wikiRegistry,
			getProxyConfig,
		}),
	);

	mountAuthorizationServer(app, {
		getProxyConfig,
		store,
		proxyRedirectPolicy,
		cimdResolver,
		defaultWikiKey,
		defaultWikiSitename,
	});

	mountReadyEndpoint(app, { activeWiki: state.activeWiki, mwnProvider: state.mwnProvider });
	mountMetricsEndpoint(app);
	setSessionsProvider(() => Object.keys(sessions).length);
	setProxyStoreStatsProvider(() => store.stats());

	return { app, sessions, inFlight };
}

// Boots the HTTP transport: loads config, enforces the static-credentials guard,
// constructs the shared proxy infrastructure, wires the app via buildApp, and
// binds the listening socket. Called by index.ts for the `http` transport. Kept
// out of module top-level so importing this module (for buildApp or a pure
// helper, as the tests do) has no side effects — no config read, no process.exit,
// no bound socket.
export function startHttpServer(): void {
	// Wiki config must load before HTTP config so evaluateBearerGuard below can
	// inspect wikiRegistry.getAll() to decide whether static credentials are
	// configured. resolveHttpConfig() reads only env vars and is order-independent
	// — placed after for visual grouping with the HTTP setup.
	const config = loadConfigFromFile();
	const state = createAppState(config);

	// Shared hosted-OAuth-proxy infrastructure, reused by the authorization-server
	// endpoints (AS metadata, register, authorize, callback, token). The proxy is
	// active only when the default wiki has an oauth2ClientId, the transport is
	// http, and the JWT signing key + public URL are set (see resolveProxyConfig).
	//
	// getDefaultProxyConfig is memoized: resolveProxyConfig reads only the default
	// wiki and process.env, both fixed for the process lifetime, so resolving once
	// is sufficient. A ProxyConfigError (e.g. signing key too short) is left to
	// propagate as a fatal misconfiguration; the eager call at startup (below)
	// forces it during boot, consistent with how the server treats other fatal
	// config errors (e.g. the static-credentials guard).
	let cachedProxyConfig: ProxyConfig | null | undefined;
	function getDefaultProxyConfig(): ProxyConfig | null {
		if (cachedProxyConfig === undefined) {
			const defaultKey = state.activeWiki.getDefaultKey();
			const wiki = state.wikiRegistry.get(defaultKey);
			cachedProxyConfig = wiki ? resolveProxyConfig(defaultKey, wiki, process.env) : null;
		}
		return cachedProxyConfig;
	}

	// The consent cookie binds a deployment-stable wiki id; we use the default
	// wiki KEY (the same key getDefaultProxyConfig resolves) for that binding, so
	// signing (buildConsentCookie) and verification (verifyConsent) agree on it.
	// The sitename is the human-readable display name shown on the consent page.
	const defaultWikiKey = state.activeWiki.getDefaultKey();
	const defaultWikiSitename = state.wikiRegistry.get(defaultWikiKey)?.sitename ?? defaultWikiKey;

	const {
		host,
		port,
		allowedHosts,
		allowedOrigins,
		maxRequestBody,
		sessionIdleTimeoutMs,
		warnings,
	} = resolveHttpConfig();
	const guard = evaluateBearerGuard(state.wikiRegistry.getAll(), process.env);
	if (guard.kind === 'block') {
		logger.error(
			'HTTP transport refuses to start because static credentials are configured for wiki(s): ' +
				guard.wikis.join(', ') +
				'.\n' +
				'A request without an Authorization header would silently act as the configured identity, ' +
				'defeating per-caller bearer passthrough.\n' +
				'Remove `token`, `username`, and `password` from these wikis in config.json, ' +
				'or set MCP_ALLOW_STATIC_FALLBACK=true to acknowledge the shared-identity deployment shape.',
		);
		process.exit(1);
	}
	if (guard.kind === 'override') {
		logger.warning(
			'MCP_ALLOW_STATIC_FALLBACK=true is set. Wiki(s) with static credentials: ' +
				guard.wikis.join(', ') +
				'. ' +
				'Requests without an Authorization header will act as the configured identity. ' +
				'This deployment cannot attribute writes to individual callers.',
		);
	}
	for (const warning of warnings) {
		logger.warning(warning);
	}
	// Resolve the proxy config eagerly so a ProxyConfigError fails the boot rather
	// than the first request. Memoized, so the route handlers reuse the cached result.
	const eagerProxyConfig = getDefaultProxyConfig();
	const proxyEnabled = eagerProxyConfig !== null;
	// Single process-wide proxy store, shared by the proxy handlers
	// (register/authorize/callback/token). It persists its durable state (client
	// registrations + upstream tokens) to an encrypted local file when the proxy is
	// enabled; otherwise it is a plain in-memory store. createProxyStore hydrates
	// synchronously here, before the server binds, so a restart resolves existing
	// tokens with no browser round-trip.
	const proxyStore: ProxyStore = createProxyStore(eagerProxyConfig, {
		onError: (err) => logger.error(`Proxy store persistence write failed: ${err.message}`),
	});
	// Built once: the register-time redirect predicate (built-ins + operator
	// entries from MCP_OAUTH_ALLOWED_REDIRECTS). /authorize keeps matching the
	// registered URIs verbatim and never re-applies this policy.
	const proxyRedirectPolicy = eagerProxyConfig
		? buildRedirectPolicy(eagerProxyConfig.redirectAllowlist)
		: null;
	// Built once from the resolved proxy config: resolves a URL client_id into a
	// ClientRecord by fetching its CIMD metadata document over the SSRF-guarded
	// fetcher. Null when the proxy is disabled.
	const cimdResolver = eagerProxyConfig
		? new CimdResolver(buildCimdHostPredicate(eagerProxyConfig.cimdAllowedHosts), fetchCimdDocument)
		: null;
	emitStartupBanner(
		{ transport: 'http', http: { host, port, allowedHosts, allowedOrigins, maxRequestBody } },
		{
			wikiRegistry: state.wikiRegistry,
			activeWiki: state.activeWiki,
			uploadDirs: state.uploadDirs,
			proxyEnabled,
		},
	);

	const ctx = createToolContext({
		logger,
		state,
		transport: 'http',
		getProxyConfig: getDefaultProxyConfig,
	});

	const { app, sessions, inFlight } = buildApp({
		state,
		getProxyConfig: getDefaultProxyConfig,
		proxyStore,
		proxyRedirectPolicy,
		cimdResolver,
		defaultWikiKey,
		defaultWikiSitename,
		createServerFn: () => createServer(ctx),
		host,
		allowedHosts,
		allowedOrigins,
		maxRequestBody,
		sessionIdleTimeoutMs,
	});

	const httpServer = app.listen(port, host, () => {
		// Express fires this callback even when the bind failed (e.g. EADDRINUSE), where
		// httpServer.listening is false. Guard the success log so a failed start does not
		// print a misleading "listening" line just before handleListenError reports it.
		if (httpServer.listening) {
			logger.info(`MCP Streamable HTTP Server listening on ${host}:${port}`);
		}
	});
	httpServer.on('error', (err) => handleListenError(err, host, port));

	registerShutdownHandlers({
		transport: 'http',
		graceMs: resolveShutdownGrace(process.env),
		httpServer,
		sessions,
		inFlight,
	});
}
