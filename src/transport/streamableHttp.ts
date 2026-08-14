#!/usr/bin/env node

import express, {
	type ErrorRequestHandler,
	type RequestHandler,
	type Request,
	type Response,
} from 'express';
import {
	createMcpHandler,
	INTERNAL_ERROR,
	InMemoryServerEventBus,
	isJsonContentType,
	PARSE_ERROR,
	type McpServer,
} from '@modelcontextprotocol/server';
import {
	hostHeaderValidation,
	localhostHostValidation,
	originValidation,
} from '@modelcontextprotocol/express';
import { evaluateBearerGuard } from './bearerGuard.ts';
import {
	basicAuthEnabled,
	bearerPassthroughEnabled,
	hasStaticCredentials,
} from '../runtime/authShape.ts';
import { LOCALHOST_HOSTS, resolveHttpConfig } from './httpConfig.ts';
import { logger } from '../runtime/logger.ts';
import {
	getMetricsHandler,
	initMetrics,
	isMetricsEnabled,
	setInFlightProvider,
	setSubscriptionStreamsProvider,
	setProxyStoreStatsProvider,
} from '../runtime/metrics.ts';
import { createInFlightCounter, type InFlightCounter } from './inFlight.ts';
import { createMcpRouteHandler, resolveRequestProto, type ProxyConfigGetter } from './mcpRoute.ts';
import { createRateLimiter, type RateLimiter } from './rateLimit.ts';
import { PAYLOAD_TOO_LARGE_ERROR_CODE } from './errorCodes.ts';
import { mountReadyEndpoint } from './ready.ts';
import { loadConfigFromFile } from '../config/loadConfig.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import { fetchMetadata, type UpstreamAsMetadata } from '../auth/metadata.ts';
import { buildProtectedResource } from '../auth/protectedResource.ts';
import { resolveProxyConfig, type ProxyConfig } from '../auth/authorizationServer/proxyConfig.ts';
import type { ProxyStore } from '../auth/authorizationServer/proxyStore.ts';
import { createProxyStore } from '../auth/authorizationServer/proxyStorePersistence.ts';
import { mountAuthorizationServer } from '../auth/authorizationServer/router.ts';
import { buildRedirectPolicy } from '../auth/authorizationServer/redirectPolicy.ts';
import { buildCimdHostPredicate, CimdResolver } from '../auth/authorizationServer/cimd.ts';
import { fetchCimdDocument } from './cimdFetch.ts';
import { createAppState, type AppState } from '../wikis/state.ts';
import { createServer, type ChangePublisher, type CreateServerOptions } from '../server.ts';
import { emitStartupBanner } from '../runtime/banner.ts';
import { createToolContext } from '../runtime/createContext.ts';
import { registerShutdownHandlers, resolveShutdownGrace } from '../runtime/shutdown.ts';

// The exported surface here (BuildAppDeps, and the protected-resource handler's
// deps) names this type, so a caller has to be able to name it too.
export type { ProxyConfigGetter };

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
// than mounted on the /mcp prefix. Always returns a guard: the spec makes Origin
// validation unconditional, and an allowlist that reduces to nothing must refuse
// every cross-origin request rather than wave them all through. A request with no
// Origin header is unaffected either way — that is every non-browser client.
export function resolveMcpOriginValidation(allowedOrigins: readonly string[]): RequestHandler {
	const hostnames = toOriginHostnames(allowedOrigins);
	if (allowedOrigins.length > 0 && hostnames.length === 0) {
		logger.warning(
			'MCP_ALLOWED_ORIGINS is set but no usable hostname could be read from it, ' +
				'so every browser request will be refused. Correct the values or unset the variable.',
		);
	}
	return originValidation([...hostnames]);
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

export function createOAuthProtectedResourceHandler(deps: {
	wikiRegistry: WikiRegistry;
	// Required: this document exists only while the hosted proxy does, so a caller
	// that omitted it would silently disable the endpoint rather than select a
	// fallback. Pass `() => null` to mean "no proxy".
	getProxyConfig: ProxyConfigGetter;
}): RequestHandler {
	return async (req, res, next) => {
		try {
			// Only the hosted proxy makes this server an authorization server. Without
			// it there is nothing to advertise: naming the wikis' own issuers is what
			// steered clients into minting tokens this server must not accept. Answered
			// before the metadata fetches below, so an unauthenticated request no
			// longer triggers one outbound fetch per OAuth wiki.
			const proxyConfig = deps.getProxyConfig();
			if (!proxyConfig) {
				res.status(404).end();
				return;
			}
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
			const doc = buildProtectedResource({
				wikis,
				metadatas,
				requestHost: req.headers.host ?? undefined,
				requestProto,
				authorizationServers: [proxyConfig.issuer],
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

// express.json() is mounted app-wide, so its failures also reach the browser-facing
// authorization-server routes under the same /mcp prefix, where an OAuth client
// expects RFC 6749's error shape rather than a JSON-RPC envelope. Only the JSON-RPC
// endpoint itself gets the JSON-RPC dialect. Express matches `/mcp` non-strictly and
// case-insensitively by default, so the trailing-slash and case-variant spellings
// reach that same route and must be recognised here too.
function isMcpEndpoint(req: Request): boolean {
	const path = req.path.toLowerCase();
	return path === '/mcp' || path === '/mcp/';
}

// The browser-facing authorization-server routes speak RFC 6749; the JSON-RPC
// endpoint speaks JSON-RPC. A body-parser failure happens before routing, so an
// unrouted path reaches this handler too and gets neither dialect: telling an
// arbitrary path it is an OAuth endpoint would advertise the whole server as one.
const AUTHORIZATION_SERVER_PATHS: ReadonlySet<string> = new Set([
	'/mcp/register',
	'/mcp/authorize',
	'/mcp/consent',
	'/mcp/oauth/callback',
	'/mcp/token',
	'/.well-known/oauth-authorization-server',
	'/.well-known/oauth-authorization-server/mcp',
]);

type ErrorDialect = 'jsonrpc' | 'oauth' | 'plain';

function dialectFor(req: Request): ErrorDialect {
	const path = req.path.toLowerCase();
	if (isMcpEndpoint(req)) {
		return 'jsonrpc';
	}
	const withoutTrailingSlash = path.length > 1 ? path.replace(/\/+$/, '') : path;
	return AUTHORIZATION_SERVER_PATHS.has(withoutTrailingSlash) ? 'oauth' : 'plain';
}

// body-parser tags each of its failures with a `type` discriminator; anything
// else reaching an error handler carries none.
function bodyErrorType(err: unknown): string | undefined {
	if (typeof err !== 'object' || err === null || !('type' in err)) {
		return undefined;
	}
	return typeof err.type === 'string' ? err.type : undefined;
}

// Express attaches a status to the failures it can characterise; anything else
// is ours and is a 500.
function errorStatus(err: unknown): number {
	if (typeof err === 'object' && err !== null && 'status' in err) {
		const { status } = err;
		if (typeof status === 'number' && status >= 400 && status <= 599) {
			return status;
		}
	}
	return 500;
}

// The terminal error handler, mounted after every route so that both a
// body-parser failure and a throw from a route reach it. Without it they reach
// Express's finalhandler, which answers HTML — unparseable by an MCP client, and
// carrying absolute filesystem paths in a stack trace outside production. The
// error is never serialised into the response for that reason.
export function errorHandler(limit: string): ErrorRequestHandler {
	return (err, req, res, _next) => {
		if (res.headersSent) {
			return;
		}
		const type = bodyErrorType(err);
		const tooLarge = type === 'entity.too.large';
		const parseFailed = type === 'entity.parse.failed';
		const status = tooLarge ? 413 : parseFailed ? 400 : errorStatus(err);
		const message = tooLarge
			? `Request body exceeds the configured maximum size of ${limit}`
			: parseFailed
				? 'Request body is not valid JSON'
				: 'Request could not be processed';

		switch (dialectFor(req)) {
			case 'jsonrpc':
				res.status(status).json({
					jsonrpc: '2.0',
					// The id is omitted rather than null: this revision's error shape
					// admits only a string or a number, and every failure reaching here
					// happened before a request id could be read.
					error: { code: jsonRpcCodeFor(tooLarge, parseFailed), message },
				});
				return;
			case 'oauth':
				res.status(status).json({ error: 'invalid_request', error_description: message });
				return;
			default:
				res.status(status).json({ error: message });
		}
	};
}

function jsonRpcCodeFor(tooLarge: boolean, parseFailed: boolean): number {
	if (tooLarge) {
		return PAYLOAD_TOO_LARGE_ERROR_CODE;
	}
	return parseFailed ? PARSE_ERROR : INTERNAL_ERROR;
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
	// Called once per serving unit — every HTTP request under createMcpHandler
	// (modern or stateless legacy alike) gets a fresh instance. The options
	// carry the change publisher buildApp wires to the handler's notify facade.
	createServerFn: (opts?: CreateServerOptions) => McpServer | Promise<McpServer>;
	host: string;
	allowedHosts?: string[];
	// Required, and empty means refuse every cross-origin request. See
	// resolveMcpOriginValidation.
	allowedOrigins: readonly string[];
	maxRequestBody: string;
	// Limits tools/call per caller; omitted when disabled (MCP_RATE_LIMIT=0).
	rateLimiter?: RateLimiter;
}

export interface BuiltApp {
	app: express.Express;
	inFlight: InFlightCounter;
	// The era-routing /mcp handler; shutdown calls close() after the in-flight
	// drain to end subscriptions/listen streams gracefully.
	mcpHandler: { close: () => Promise<void> };
	// The change-event bus behind subscriptions/listen; its listenerCount is
	// the number of open subscription streams.
	bus: InMemoryServerEventBus;
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
		rateLimiter,
	} = deps;

	// A `private` wiki challenges anonymous callers with a 401 whose discovery
	// document only resolves to an authorization server when the wiki has an
	// `oauth2ClientId`. Warn the operator about a private wiki that lacks one.
	for (const [key, cfg] of Object.entries(state.wikiRegistry.getAll())) {
		const hasAs = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
		if (cfg.private === true && !hasAs) {
			logger.warning(
				`Wiki "${key}" is marked private but has no oauth2ClientId, so a client cannot be ` +
					'pointed anywhere to sign in. Configure hosted OAuth sign-in (oauth2ClientId, ' +
					'oauth2ClientSecret, MCP_PUBLIC_URL and MCP_OAUTH_JWT_SIGNING_KEY) or unset `private`.',
			);
		}
	}

	const app = express();
	// The type predicate must match the SDK's own, or a Content-Type it accepts
	// but body-parser's default matcher rejects (`application/json;`) arrives
	// unparsed: the handler then reads the raw stream while req.body is undefined,
	// bypassing both the size cap and anything that classifies from the body.
	app.use(
		express.json({
			limit: maxRequestBody,
			type: (req) => isJsonContentType(req.headers['content-type']),
		}),
	);

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
	const mcpOriginGuard: RequestHandler[] = [resolveMcpOriginValidation(allowedOrigins)];

	// Every non-loopback bind, not only the two wildcard spellings: a bind to a
	// specific routable address is just as reachable from another origin.
	if (!LOCALHOST_HOSTS.includes(host) && allowedOrigins.length === 0) {
		logger.warning(
			`Server is binding to ${host} with no Origin allowlist, so every browser ` +
				'request will be refused. Set MCP_ALLOWED_ORIGINS to the origins your ' +
				'browser-based clients are served from. Clients that send no Origin ' +
				'header are unaffected.',
		);
	}

	const inFlight = createInFlightCounter();
	app.use('/mcp', inFlight.middleware);

	// The change-event bus behind subscriptions/listen. Owned here (rather than
	// auto-created inside the handler) so the subscription-stream count is
	// observable and the reconcile publisher can reach subscribers through the
	// handler's notify facade below.
	const bus = new InMemoryServerEventBus((error) =>
		logger.error(`Change-event listener failed: ${error.message}`),
	);
	// The publisher the per-request server factory hands to createServer's
	// reconcile callback: a per-request instance has no client left to push to
	// by the time add-wiki / remove-wiki changes anything, so change events go
	// to every open subscriptions/listen stream instead. Deliberately closes
	// over `handler` (assigned next) — the factory only runs per request, long
	// after the handler exists.
	const publisher: ChangePublisher = {
		toolsChanged: (): void => handler.notify.toolsChanged(),
		resourcesChanged: (): void => handler.notify.resourcesChanged(),
	};
	const handler = createMcpHandler(() => createServerFn({ publisher }), {
		legacy: 'stateless',
		bus,
		onerror: (error) => logger.error(`MCP handler error: ${error.message}`),
	});

	const mcpRoute = createMcpRouteHandler(handler, {
		wikiRegistry: state.wikiRegistry,
		getProxyConfig,
		proxyStore: store,
		defaultWikiKey,
		onerror: (error) => logger.error(`MCP adapter error: ${error.message}`),
		rateLimiter,
	});
	// OPTIONS is routed explicitly: Express answers it from its own default
	// handler otherwise, which sits outside the route stack and so outside the
	// Origin guard. The operational endpoints below are deliberately not guarded
	// — they are read-only, set no CORS headers, and so cannot be read
	// cross-origin, while a probe from Kubernetes or Prometheus sends no Origin
	// and would be unaffected either way.
	app.post('/mcp', ...mcpOriginGuard, mcpRoute);
	app.get('/mcp', ...mcpOriginGuard, mcpRoute);
	app.delete('/mcp', ...mcpOriginGuard, mcpRoute);
	app.options('/mcp', ...mcpOriginGuard, mcpRoute);

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
	setInFlightProvider(inFlight.count);
	// Every open subscriptions/listen stream registers one bus listener, so the
	// listener count IS the open-stream count (nothing else subscribes).
	setSubscriptionStreamsProvider(() => bus.listenerCount);
	setProxyStoreStatsProvider(() => store.stats());

	// Last, so that a throw from any route above reaches it as well as a
	// body-parser failure from before routing.
	app.use(errorHandler(maxRequestBody));

	return { app, inFlight, mcpHandler: handler, bus };
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

	const { host, port, allowedHosts, allowedOrigins, maxRequestBody, rateLimit, warnings } =
		resolveHttpConfig();
	const guard = evaluateBearerGuard(state.wikiRegistry.getAll(), process.env);
	if (guard.kind === 'block') {
		logger.error(
			'HTTP transport refuses to start because static credentials are configured for wiki(s): ' +
				guard.wikis.join(', ') +
				'.\n' +
				'A request without an Authorization header would silently act as the configured identity, ' +
				'so writes could not be attributed to the caller that made them.\n' +
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
	if (bearerPassthroughEnabled()) {
		logger.warning(
			proxyEnabled
				? 'MCP_ALLOW_BEARER_PASSTHROUGH=true is set but has no effect: hosted OAuth sign-in ' +
						'is configured, so a bearer is read as a token this server issued and a ' +
						'caller-supplied one is refused. Unset the variable.'
				: 'MCP_ALLOW_BEARER_PASSTHROUGH=true is set. A caller-supplied Authorization header ' +
						'is forwarded to MediaWiki as that caller. This is deprecated: MCP servers must ' +
						'not accept tokens that were not issued for them. Prefer the hosted OAuth ' +
						'sign-in, which issues this server its own tokens.',
		);
	}
	if (basicAuthEnabled()) {
		logger.info(
			'Accepting Authorization: Basic credentials. A caller may send a MediaWiki bot ' +
				'password (base64 of "username:password") and the server acts as that user for ' +
				'the request, in preference to any credentials configured for the wiki. Terminate ' +
				'TLS in front of this server: the credentials are recoverable from the header. ' +
				'Set MCP_ALLOW_BASIC_AUTH=false to refuse them.',
		);
	}
	// A deployment can now be configured so that nothing it serves can authenticate:
	// wikis that require OAuth, no hosted sign-in to mint a token, and no opted-in
	// forwarding to carry one. Nothing a client sends can fix that, so say it here
	// rather than leaving every call to fail upstream.
	// Basic credentials are one such way, so a deployment accepting them is never
	// stranded: whatever the wikis require, a caller can send a bot password.
	if (!proxyEnabled && !bearerPassthroughEnabled() && !basicAuthEnabled()) {
		const staticAllowed = process.env.MCP_ALLOW_STATIC_FALLBACK === 'true';
		const stranded = Object.entries(state.wikiRegistry.getAll())
			.filter(([key, cfg]) => {
				const usesOAuth =
					typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
				const usableStatic = hasStaticCredentials(cfg) && staticAllowed;
				// A `private` DEFAULT wiki cannot be rescued by static credentials: the
				// route challenges a tokenless request before any credential is
				// resolved, so every request to such a deployment is answered 401.
				if (cfg.private === true && key === defaultWikiKey) {
					return true;
				}
				return (usesOAuth || cfg.private === true) && !usableStatic;
			})
			.map(([key]) => key);
		if (stranded.length > 0) {
			logger.warning(
				'No way to authenticate to wiki(s): ' +
					stranded.join(', ') +
					'. They require a signed-in user, but the hosted OAuth sign-in is not configured, ' +
					'Basic credentials are refused (MCP_ALLOW_BASIC_AUTH=false) and forwarding a ' +
					'caller-supplied token is off. Unset MCP_ALLOW_BASIC_AUTH, or set MCP_PUBLIC_URL ' +
					'and MCP_OAUTH_JWT_SIGNING_KEY to enable hosted sign-in (see docs/deployment.md).',
			);
		}
	}
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

	if (rateLimit) {
		logger.info(
			`Rate limiting tools/call: ${rateLimit.ratePerSecond}/s per authenticated caller ` +
				`(burst ${rateLimit.burst}), anonymous callers ` +
				(rateLimit.anonymousRatePerSecond > 0
					? `${rateLimit.anonymousRatePerSecond}/s shared`
					: 'unlimited') +
				'. Tune with MCP_RATE_LIMIT, MCP_RATE_LIMIT_BURST, MCP_RATE_LIMIT_ANONYMOUS.',
		);
	} else {
		logger.warning('Rate limiting is disabled (MCP_RATE_LIMIT=0).');
	}
	const { app, inFlight, mcpHandler } = buildApp({
		state,
		getProxyConfig: getDefaultProxyConfig,
		proxyStore,
		proxyRedirectPolicy,
		cimdResolver,
		defaultWikiKey,
		defaultWikiSitename,
		createServerFn: (opts) => createServer(ctx, opts),
		host,
		allowedHosts,
		allowedOrigins,
		maxRequestBody,
		rateLimiter: rateLimit ? createRateLimiter(rateLimit) : undefined,
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
		inFlight,
		mcpHandler,
	});
}
