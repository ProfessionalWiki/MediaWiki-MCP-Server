#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import express, {
	type ErrorRequestHandler,
	type RequestHandler,
	type Request,
	type Response,
} from 'express';
import {
	hostHeaderValidation,
	localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { evaluateBearerGuard, hasStaticCredentials } from './bearerGuard.js';
import { LOCALHOST_HOSTS, resolveHttpConfig } from './httpConfig.js';
import { logger } from '../runtime/logger.js';
import {
	getMetricsHandler,
	initMetrics,
	isMetricsEnabled,
	recordReadyFailure,
	setSessionsProvider,
	setProxyStoreStatsProvider,
} from '../runtime/metrics.js';
import { withRequestContext } from './requestContext.js';

export { withRequestContext } from './requestContext.js';
import { loadConfigFromFile, type WikiConfig } from '../config/loadConfig.js';
import type { MwnProvider } from '../wikis/mwnProvider.js';
import type { ActiveWiki } from '../wikis/activeWiki.js';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import { fetchMetadata, type AsMetadata } from '../auth/metadata.js';
import { buildProtectedResource, resolvePublicBase } from '../auth/protectedResource.js';
import { resolveProxyConfig, type ProxyConfig } from '../auth/authorizationServer/proxyConfig.js';
import type { ProxyStore, ClientRecord } from '../auth/authorizationServer/proxyStore.js';
import {
	refreshTokens as defaultRefresh,
	classifyRefreshError,
	type RefreshArgs,
} from '../auth/oauthFlow.js';
import { buildAsMetadata } from '../auth/authorizationServer/asMetadata.js';
import { handleRegister } from '../auth/authorizationServer/register.js';
import { createProxyStore } from '../auth/authorizationServer/proxyStorePersistence.js';
import { buildRedirectPolicy } from '../auth/authorizationServer/redirectPolicy.js';
import {
	buildCimdHostPredicate,
	isCimdClientId,
	CimdResolver,
} from '../auth/authorizationServer/cimd.js';
import { fetchCimdDocument } from './cimdFetch.js';
import {
	planAuthorize,
	planDeny,
	type AuthorizeQuery,
	type ConsentClaims,
} from '../auth/authorizationServer/authorize.js';
import {
	renderConsentPage,
	renderCancelledPage,
	renderAuthErrorPage,
	buildConsentCookie,
	readConsentCookie,
	buildCsrfCookie,
	readCsrfCookie,
	buildTxnCookie,
	readTxnCookie,
	clearTxnCookie,
} from '../auth/authorizationServer/consent.js';
import { verifyAccessToken, verifyConsent } from '../auth/authorizationServer/jwt.js';
import { handleCallback } from '../auth/authorizationServer/callback.js';
import { handleToken } from '../auth/authorizationServer/token.js';
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

export type SessionEntry = {
	readonly transport: StreamableHTTPServerTransport;
	idleTimer?: ReturnType<typeof setTimeout>;
	activeRequests: number;
};

export type SessionRegistry = { [sessionId: string]: SessionEntry };

export interface InFlightCounter {
	readonly middleware: RequestHandler;
	readonly count: () => number;
}

export function createInFlightCounter(): InFlightCounter {
	let n = 0;
	const middleware: RequestHandler = (_req, res, next) => {
		n++;
		res.on('close', () => {
			n--;
		});
		next();
	};
	return { middleware, count: () => n };
}

// Marks a session as having an in-flight request or open response stream:
// increments the active-request count and cancels any pending idle expiry.
// Pair every call with markSessionIdle on the response's 'close' event.
export function markSessionActive(sessions: SessionRegistry, sessionId: string): void {
	const entry = sessions[sessionId];
	if (!entry) {
		return;
	}
	entry.activeRequests += 1;
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
}

// Marks one request/stream finished. When the session has no remaining
// in-flight requests, arms the idle-expiry timer; when it elapses the transport
// is closed and its onclose handler removes the registry entry. A timeout of 0
// disables expiry. Because this runs on response 'close', a long-lived GET SSE
// stream keeps the session active for as long as the client holds it open.
export function markSessionIdle(
	sessions: SessionRegistry,
	sessionId: string,
	idleTimeoutMs: number,
): void {
	const entry = sessions[sessionId];
	if (!entry) {
		return;
	}
	entry.activeRequests = Math.max(0, entry.activeRequests - 1);
	if (entry.activeRequests > 0 || idleTimeoutMs <= 0) {
		return;
	}
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		void sessions[sessionId]?.transport.close();
	}, idleTimeoutMs);
	entry.idleTimer.unref();
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
				.filter((r): r is PromiseFulfilledResult<AsMetadata> => r.status === 'fulfilled')
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
			const protoHeader = req.headers['x-forwarded-proto'];
			const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() : undefined;
			const requestProto =
				proto === 'https' || proto === 'http' ? proto : req.secure ? 'https' : 'http';
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

// A wiki needs auth when it is OAuth-only with no usable static fallback.
function wikiNeedsAuth(cfg: WikiConfig, fallbackAllowed: boolean): boolean {
	const oauthOnly = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
	if (!oauthOnly) {
		return false;
	}
	const hasStatic = hasStaticCredentials(cfg);
	return !(hasStatic && fallbackAllowed);
}

// Refresh tokens within this window of expiry rather than waiting for an actual
// upstream 401, so the very next wiki call uses a fresh token.
const UPSTREAM_REFRESH_SKEW_MS = 30_000;

type RefreshFn = (a: RefreshArgs) => Promise<{
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}>;

// Thrown by resolveUpstreamBearer when a proxy JWT cannot be resolved to a usable
// upstream token. `retryable` distinguishes a transient upstream failure (the /mcp
// handler answers 503 temporarily_unavailable) from a dead credential (a 401 +
// re-auth challenge), mirroring how the /token grant maps the same refresh errors.
export class UpstreamBearerError extends Error {
	public constructor(
		public readonly retryable: boolean,
		message: string,
	) {
		super(message);
		this.name = 'UpstreamBearerError';
	}
}

// In-flight proactive refreshes keyed by upstreamTokenId. When two /mcp requests
// both land inside the refresh-skew window they would otherwise present the SAME
// upstream refresh token to the wiki concurrently; if the wiki rotates it on use,
// the loser's token is revoked out from under it. Coalescing collapses them into a
// single upstream refresh whose result both callers share. This guards proactive-
// vs-proactive only. A proactive refresh racing a downstream /token refresh grant
// for the same token is NOT coordinated here: beginRefreshRotation gates reuse of
// the DOWNSTREAM refresh token on the /token path, but neither path locks the
// UPSTREAM refresh token against the other, so both can still present it at once.
// That race is pre-existing and left as accepted residual risk for the single-
// process deployment; closing it needs a shared per-upstream-token refresh lock
// held across both paths.
const inFlightUpstreamRefresh = new Map<string, Promise<string>>();

function coalesceUpstreamRefresh(id: string, run: () => Promise<string>): Promise<string> {
	const existing = inFlightUpstreamRefresh.get(id);
	if (existing) {
		return existing;
	}
	const pending = run().finally(() => inFlightUpstreamRefresh.delete(id));
	inFlightUpstreamRefresh.set(id, pending);
	return pending;
}

// Performs the server-to-server upstream refresh, writes the rotated token back to
// the store, and returns the fresh access token.
async function performUpstreamRefresh(
	upstreamTokenId: string,
	currentRefreshToken: string,
	pc: ProxyConfig,
	store: ProxyStore,
	refresh: RefreshFn,
): Promise<string> {
	const r = await refresh({
		tokenEndpoint: `${pc.tokenExchangeBase}${pc.scriptpath}/rest.php/oauth2/access_token`,
		refreshToken: currentRefreshToken,
		clientId: pc.upstreamClientId,
		clientSecret: pc.upstreamClientSecret,
	});
	store.updateUpstreamToken(upstreamTokenId, {
		accessToken: r.access_token,
		refreshToken: r.refresh_token ?? currentRefreshToken,
		expiresAt: Date.now() + r.expires_in * 1000,
	});
	return r.access_token;
}

// Resolves a /mcp proxy JWT to the UPSTREAM wiki access token it stands for.
// When the proxy is enabled the bearer is a proxy-minted JWT (aud=self), not a
// wiki token, so mwn cannot use it directly: we verify the JWT, look up the
// stored upstream token by its jti, and (when it is at/near expiry and a refresh
// token exists) transparently refresh it server-to-server before returning.
//
// A proactive refresh is a pre-expiry optimization, so its failure must not by
// itself fail an otherwise-serviceable request: while the stored access token is
// still valid we fall back to it regardless of why the refresh failed (a transient
// wiki blip, or a concurrent refresh that already rotated the token). Only once the
// token is genuinely expired does a refresh failure surface — as a retryable
// UpstreamBearerError for a transient upstream failure, or a non-retryable one for
// a dead refresh token. verifyAccessToken throws on an invalid/expired/mis-
// audienced JWT; the caller maps that (and a missing upstream token) to a 401.
export async function resolveUpstreamBearer(
	proxyJwt: string,
	pc: ProxyConfig,
	store: ProxyStore,
	refresh: RefreshFn = defaultRefresh,
): Promise<string> {
	const { upstreamTokenId } = await verifyAccessToken(proxyJwt, pc);
	const upstream = store.getUpstreamToken(upstreamTokenId);
	if (!upstream) {
		throw new Error('upstream token not found');
	}
	if (!(upstream.expiresAt <= Date.now() + UPSTREAM_REFRESH_SKEW_MS && upstream.refreshToken)) {
		return upstream.accessToken;
	}
	const currentRefreshToken = upstream.refreshToken;
	try {
		return await coalesceUpstreamRefresh(upstreamTokenId, () =>
			performUpstreamRefresh(upstreamTokenId, currentRefreshToken, pc, store, refresh),
		);
	} catch (err) {
		if (Date.now() < upstream.expiresAt) {
			return upstream.accessToken;
		}
		throw new UpstreamBearerError(
			classifyRefreshError(err) === 'retryable',
			'upstream token refresh failed',
		);
	}
}

export interface McpPostHandlerOptions {
	allowedOrigins?: string[];
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
// Persist the proxy transaction id (carried as `state` on the upstream authorize
// URL) in a cookie, so the callback can recover it even when the upstream drops
// `state` on a denial (MediaWiki's Extension:OAuth does).
function setTxnCookie(res: Response, upstreamLocation: string): void {
	const txnId = new URL(upstreamLocation).searchParams.get('state');
	if (txnId) {
		res.append('Set-Cookie', buildTxnCookie(txnId));
	}
}

function emit401Challenge(req: Request, res: Response): void {
	const protoHeader = req.headers['x-forwarded-proto'];
	const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() : undefined;
	const requestProto =
		proto === 'https' || proto === 'http' ? proto : req.secure ? 'https' : 'http';
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
		allowedOrigins,
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
		let transport: StreamableHTTPServerTransport;

		if (sessionId && sessions[sessionId]) {
			transport = sessions[sessionId].transport;
			// Existing session: the registry entry already exists, so count this
			// request now and release it when the response closes.
			markSessionActive(sessions, sessionId);
		} else if (!sessionId && isInitializeRequest(req.body)) {
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				// The SDK transport's Origin check is gated behind this flag.
				// Host-header validation stays in Express middleware upstream, so
				// we don't pass allowedHosts here (that inner check no-ops when
				// _allowedHosts is undefined, regardless of the flag).
				enableDnsRebindingProtection: allowedOrigins !== undefined,
				allowedOrigins,
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

interface ReadyCacheEntry {
	expiresAt: number;
	payload: { status: 'ready' | 'not_ready'; wiki: string; reason?: string; checked_at: string };
	httpStatus: 200 | 503;
}

const READY_CACHE_TTL_MS = 5_000;
const READY_PROBE_TIMEOUT_MS = 3_000;
let readyCache: ReadyCacheEntry | null = null;

export function __resetReadyCacheForTesting(): void {
	readyCache = null;
}

async function probeDefaultWiki(
	activeWiki: ActiveWiki,
	mwnProvider: MwnProvider,
): Promise<ReadyCacheEntry> {
	const wiki = activeWiki.getDefaultKey();
	const checkedAt = new Date().toISOString();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('probe timeout after 3000ms')),
			READY_PROBE_TIMEOUT_MS,
		);
	});

	try {
		const mwn = await mwnProvider.get();
		await Promise.race([
			mwn.request({
				action: 'query',
				meta: 'siteinfo',
				format: 'json',
				siprop: 'general',
			}),
			timeout,
		]);
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'ready', wiki, checked_at: checkedAt },
			httpStatus: 200,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'not_ready', wiki, reason, checked_at: checkedAt },
			httpStatus: 503,
		};
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

// Test seam: exported so the timeout test can call the probe directly,
// bypassing supertest's lazy request sending under vi.useFakeTimers.
export const __probeDefaultWikiForTesting = probeDefaultWiki;

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

export function mountReadyEndpoint(
	app: express.Express,
	deps: {
		activeWiki: ActiveWiki;
		mwnProvider: MwnProvider;
	},
): void {
	app.get('/ready', async (_req, res) => {
		if (!readyCache || Date.now() >= readyCache.expiresAt) {
			readyCache = await probeDefaultWiki(deps.activeWiki, deps.mwnProvider);
			// Count distinct probe failures, not cached replays — K8s readiness
			// probes that fire every second would otherwise inflate the counter
			// 5x against a 5s cache for the same underlying outage.
			if (readyCache.httpStatus !== 200) {
				recordReadyFailure();
			}
		}
		res.status(readyCache.httpStatus).json(readyCache.payload);
	});
}

// The HTTP server's boot — config load, the static-credentials guard, proxy-
// infrastructure construction, route wiring, and app.listen — lives in
// startHttpServer() at the bottom of this module. Importing this module has no
// side effects; index.ts calls startHttpServer() for the `http` transport, and
// tests import the pure factory/helpers without booting a server.

// Extracts a human-readable reason string from an OAuth error body. The fields
// are statically typed as `unknown` (the body is a Record<string, unknown>), so
// we narrow explicitly to avoid the linter's no-base-to-string rule.
function errorReason(body: Record<string, unknown>, fallback: string): string {
	const v = body.error_description ?? body.error;
	return typeof v === 'string' ? v : fallback;
}

// Reads the subset of query parameters planAuthorize cares about, coercing each
// to a single string (Express may parse repeated/array/nested params, which the
// OAuth params are never expected to be; only the first scalar is honoured).
function readAuthorizeQuery(query: Request['query']): AuthorizeQuery {
	const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
	return {
		client_id: one(query.client_id),
		redirect_uri: one(query.redirect_uri),
		state: one(query.state),
		code_challenge: one(query.code_challenge),
		code_challenge_method: one(query.code_challenge_method),
		scope: one(query.scope),
		resource: one(query.resource),
	};
}

// Re-serialises the AuthorizeQuery so the consent form's POST action carries the
// exact same parameters back to /mcp/consent. Built from the parsed query rather
// than req.originalUrl so it round-trips only the recognised OAuth params.
function serializeAuthorizeQuery(q: AuthorizeQuery): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(q)) {
		if (typeof v === 'string') {
			sp.set(k, v);
		}
	}
	return sp.toString();
}

// Parses a request's redirect_uri hostname, returning undefined when it is
// missing or not a valid absolute URL. planAuthorize independently rejects an
// unregistered/missing redirect, so a parse failure here just means "no consent".
function redirectHostOf(redirectUri: string | undefined): string | undefined {
	if (!redirectUri) {
		return undefined;
	}
	try {
		return new URL(redirectUri).hostname;
	} catch {
		return undefined;
	}
}

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
		createMcpPostHandler(sessions, createServerFn, {
			allowedOrigins,
			wikiRegistry: state.wikiRegistry,
			idleTimeoutMs: sessionIdleTimeoutMs,
			getProxyConfig,
			proxyStore: store,
			defaultWikiKey,
		}),
	);
	app.get('/mcp', sessionRequestHandler);
	app.delete('/mcp', sessionRequestHandler);

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

	// RFC 8414 authorization-server metadata. Served only when the hosted OAuth
	// proxy is enabled, in which case this server names itself as the AS. The
	// `/mcp` suffix variant covers clients that append the resource path segment
	// to the well-known location.
	const asMetadataHandler: RequestHandler = (_req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		res.json(buildAsMetadata(pc));
	};
	app.get('/.well-known/oauth-authorization-server', asMetadataHandler);
	app.get('/.well-known/oauth-authorization-server/mcp', asMetadataHandler);

	// RFC 7591 Dynamic Client Registration. Served only when the hosted OAuth
	// proxy is enabled. The request body is already parsed by the top-level
	// express.json() middleware. handleRegister validates redirect_uris against
	// the proxy's redirect policy before minting a public (PKCE-only) client.
	app.post('/mcp/register', (req, res) => {
		if (!getProxyConfig() || !proxyRedirectPolicy) {
			res.status(404).end();
			return;
		}
		const result = handleRegister(req.body, store, proxyRedirectPolicy);
		res.status(result.status).json(result.body);
	});

	// Resolve a client_id to a ClientRecord: CIMD (fetch its metadata document) for a
	// URL id, else the DCR store. For CIMD, `clientIdHost` is the verified host to show
	// at consent; `error` is set (with a reason) only when a CIMD resolve fails.
	async function resolveClient(clientId: string | undefined): Promise<{
		client: ClientRecord | undefined;
		clientIdHost?: string;
		error?: string;
	}> {
		if (clientId && cimdResolver && isCimdClientId(clientId)) {
			const r = await cimdResolver.resolve(clientId);
			if (!r.ok) {
				return { client: undefined, error: r.reason };
			}
			return { client: r.client, clientIdHost: new URL(clientId).host };
		}
		return { client: clientId ? store.getClient(clientId) : undefined };
	}

	// GET /mcp/authorize — the proxy authorization endpoint. Validates the client +
	// redirect, gates on the signed consent cookie (bound to clientId + redirectHost
	// + the default wiki key), and either renders the consent page or 302s to the
	// upstream wiki authorize URL.
	app.get('/mcp/authorize', async (req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		const q = readAuthorizeQuery(req.query);

		let consent: ConsentClaims | undefined;
		const redirectHost = redirectHostOf(q.redirect_uri);
		const cookie = readConsentCookie(req.headers.cookie);
		if (cookie && q.client_id && redirectHost) {
			const ok = await verifyConsent(cookie, {
				clientId: q.client_id,
				redirectHost,
				wiki: defaultWikiKey,
				signingKey: pc.signingKey,
			});
			if (ok) {
				consent = { clientId: q.client_id, redirectHost, wiki: defaultWikiKey };
			}
		}

		const resolved = await resolveClient(q.client_id);
		if (resolved.error) {
			res
				.status(400)
				.type('html')
				.send(renderAuthErrorPage({ reason: resolved.error }));
			return;
		}
		const plan = planAuthorize(q, consent, pc, store, defaultWikiSitename, resolved.client);
		if (plan.kind === 'error') {
			res
				.status(plan.status)
				.type('html')
				.send(renderAuthErrorPage({ reason: errorReason(plan.body, 'invalid request') }));
			return;
		}
		if (plan.kind === 'consent') {
			// Anti-CSRF nonce: set as a SameSite=Strict cookie and embedded in the form
			// so the decision POST can prove it came from this page (double-submit).
			const csrfToken = randomUUID();
			res.append('Set-Cookie', buildCsrfCookie(csrfToken));
			res.type('html').send(
				renderConsentPage({
					clientName: plan.clientName,
					wiki: defaultWikiSitename,
					authorizeQuery: serializeAuthorizeQuery(q),
					csrfToken,
					redirectHost: redirectHost ?? '',
					clientIdHost: resolved.clientIdHost,
				}),
			);
			return;
		}
		setTxnCookie(res, plan.location);
		res.redirect(302, plan.location);
	});

	// POST /mcp/consent — records the user's decision from the consent form. The
	// form action carries the original authorize params in the query string; the
	// decision is form-encoded in the body. On approve we set the signed consent
	// cookie and re-run planAuthorize to 302 to the upstream (Set-Cookie + 302 in
	// the one response is correct: the browser stores the cookie and follows the
	// redirect, so the subsequent upstream callback can be matched).
	app.post('/mcp/consent', express.urlencoded({ extended: false }), async (req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		const q = readAuthorizeQuery(req.query);
		const resolved = await resolveClient(q.client_id);
		if (resolved.error) {
			res
				.status(400)
				.type('html')
				.send(renderAuthErrorPage({ reason: resolved.error }));
			return;
		}
		const client = resolved.client;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- form-encoded body is untyped; decision is read defensively below
		const body = (req.body ?? {}) as Record<string, unknown>;
		const decision = typeof body.decision === 'string' ? body.decision : undefined;

		if (decision !== 'approve') {
			// Bounce a proper OAuth error back to the client when we can trust its
			// redirect_uri; otherwise show a plain page (the client can't be signalled).
			const denial = planDeny(q, pc, store, client);
			if (denial.kind === 'redirect') {
				res.redirect(302, denial.location);
				return;
			}
			res
				.status(200)
				.type('html')
				.send(renderCancelledPage({ clientName: client?.name }));
			return;
		}

		// decision === 'approve' beyond this point. CSRF: the form must echo the
		// SameSite=Strict nonce set on the consent GET. A cross-site auto-submit can
		// neither carry that cookie nor read it (HttpOnly), so it cannot forge consent.
		const csrfCookie = readCsrfCookie(req.headers.cookie);
		const csrfField = typeof body.csrf === 'string' ? body.csrf : undefined;
		if (!csrfCookie || !csrfField || csrfCookie !== csrfField) {
			res
				.status(400)
				.type('html')
				.send(renderAuthErrorPage({ reason: 'CSRF check failed' }));
			return;
		}

		const redirectHost = redirectHostOf(q.redirect_uri);
		if (!q.client_id || !redirectHost) {
			res
				.status(400)
				.type('html')
				.send(renderAuthErrorPage({ reason: 'missing client_id or redirect_uri' }));
			return;
		}

		res.append(
			'Set-Cookie',
			await buildConsentCookie(pc, {
				clientId: q.client_id,
				redirectHost,
				wiki: defaultWikiKey,
			}),
		);

		const consent: ConsentClaims = { clientId: q.client_id, redirectHost, wiki: defaultWikiKey };
		const plan = planAuthorize(q, consent, pc, store, defaultWikiSitename, client);
		if (plan.kind === 'error') {
			res
				.status(plan.status)
				.type('html')
				.send(renderAuthErrorPage({ reason: errorReason(plan.body, 'invalid request') }));
			return;
		}
		if (plan.kind === 'redirect') {
			setTxnCookie(res, plan.location);
			res.redirect(302, plan.location);
			return;
		}
		// planAuthorize returned 'consent' despite a freshly built ConsentClaims —
		// only reachable if the client vanished between validation steps. Treat as a
		// transient error rather than re-prompting (the cookie is already set).
		res
			.status(400)
			.type('html')
			.send(renderAuthErrorPage({ reason: 'consent could not be applied' }));
	});

	// GET /mcp/oauth/callback — the upstream wiki's authorization-code redirect back
	// to the proxy. The `state` param is the proxy-minted transaction id. We verify
	// the consent cookie against the transaction's client + redirect host (the same
	// binding authorize set), then hand off to handleCallback, which exchanges the
	// wiki code on the internal tokenExchangeBase, stores the upstream token, mints a
	// one-time downstream client code, and 302s back to the client redirect.
	app.get('/mcp/oauth/callback', async (req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
		const queryError = one(req.query.error);
		const q = {
			code: one(req.query.code),
			// Fall back to the txn cookie ONLY on a denial that dropped `state`
			// (MediaWiki does). Never let the cookie supply `state` for the success/code
			// path, so an injected cookie can't drive a code redemption to a stale txn.
			state:
				one(req.query.state) ??
				(queryError !== undefined ? readTxnCookie(req.headers.cookie) : undefined),
			error: queryError,
			errorDescription: one(req.query.error_description),
		};
		// The txn cookie is single-use per flow; expire it now that the callback fired.
		res.append('Set-Cookie', clearTxnCookie());

		// Re-verify the consent cookie here, bound to the transaction's own client +
		// redirect host. handleCallback re-looks-up the txn itself; this lookup only
		// supplies the binding fields for verifyConsent (an idempotent read).
		let consentOk = false;
		const txn = q.state ? store.getTransaction(q.state) : undefined;
		const cookie = readConsentCookie(req.headers.cookie);
		if (txn && cookie) {
			consentOk = await verifyConsent(cookie, {
				clientId: txn.clientId,
				redirectHost: new URL(txn.clientRedirectUri).hostname,
				wiki: defaultWikiKey,
				signingKey: pc.signingKey,
			});
		}

		const plan = await handleCallback(q, pc, store, consentOk);
		if (plan.kind === 'error') {
			res
				.status(plan.status)
				.type('html')
				.send(renderAuthErrorPage({ reason: errorReason(plan.body, 'authorization failed') }));
			return;
		}
		res.redirect(302, plan.location);
	});

	// POST /mcp/token — the proxy's RFC 6749 token endpoint. Served only when the
	// hosted OAuth proxy is enabled. Bodies are form-encoded (not JSON), so a route-
	// local express.urlencoded parser is used. handleToken handles both the
	// authorization_code grant (verify client PKCE, consume the one-time code, mint
	// proxy JWTs) and the refresh_token grant (verify the proxy refresh JWT, refresh
	// the upstream token server-to-server, re-mint).
	app.post('/mcp/token', express.urlencoded({ extended: false }), async (req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- form-encoded body is untyped; handleToken reads each field defensively
		const body = (req.body ?? {}) as Record<string, string>;
		const result = await handleToken(body, pc, store);
		res.status(result.status).json(result.body);
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
		logger.info(`MCP Streamable HTTP Server listening on ${host}:${port}`);
	});

	registerShutdownHandlers({
		transport: 'http',
		graceMs: resolveShutdownGrace(process.env),
		httpServer,
		sessions,
		inFlight,
	});
}
