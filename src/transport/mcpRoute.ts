import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
	basicAuthEnabled,
	bearerPassthroughEnabled,
	hasStaticCredentials,
} from '../runtime/authShape.ts';
import { recordRateLimited } from '../runtime/metrics.ts';
import { withRequestIdentity } from '../runtime/requestContext.ts';
import { readBasicAuthHeader } from './basicAuth.ts';
import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import { resolvePublicBase } from '../auth/protectedResource.ts';
import {
	AUTHENTICATION_REQUIRED_ERROR_CODE,
	RATE_LIMITED_ERROR_CODE,
	UPSTREAM_UNAVAILABLE_ERROR_CODE,
} from './errorCodes.ts';
import type { RateLimitDecision, RateLimiter } from './rateLimit.ts';
import type { ProxyConfig } from '../auth/authorizationServer/proxyConfig.ts';
import type { ProxyStore } from '../auth/authorizationServer/proxyStore.ts';
import {
	resolveUpstreamBearer,
	UpstreamBearerError,
	type RefreshFn,
} from '../auth/upstreamBearer.ts';

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

// Resolves the request's scheme, honouring a trusted reverse proxy's
// x-forwarded-proto (first value) and falling back to the socket's own security.
export function resolveRequestProto(req: Request): 'http' | 'https' {
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

// Returns the active hosted-OAuth-proxy config, or null when the proxy is
// disabled. getDefaultProxyConfig in streamableHttp.ts is the production
// implementation.
export type ProxyConfigGetter = () => ProxyConfig | null;

// The id an error emitted before dispatch may echo, following the same rule as the
// SDK's own echoableRequestId: only a single JSON-RPC request object with a string
// method carries an id this layer can attribute the error to. A batch, a
// notification, a posted response and a body-less method do not, and the 2026-07-28
// error shape has no admissible value for "unknown", so the field is omitted.
function echoableRequestId(body: unknown): string | number | undefined {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return undefined;
	}
	if (!('method' in body) || typeof body.method !== 'string') {
		return undefined;
	}
	if (!('id' in body)) {
		return undefined;
	}
	const id: unknown = body.id;
	return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function echoedId(req: Request): { id?: string | number } {
	const id = echoableRequestId(req.body);
	return id === undefined ? {} : { id };
}

// Emits the shared OAuth 401 challenge: a JSON-RPC error body with the
// WWW-Authenticate: Bearer ... resource_metadata=... header pointing at this
// server's protected-resource document. Reused by the legacy OAuth-only
// short-circuit and the proxy invalid-JWT path so both speak the same dialect.
// `hasMetadata` says whether this server publishes a protected-resource document,
// which is true only while the hosted proxy is enabled. Pointing a client at that
// URL when it 404s sends it to a dead end, so the parameter is omitted instead;
// RFC 6750 admits a challenge without it.
function emit401Challenge(req: Request, res: Response, hasMetadata: boolean): void {
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
		hasMetadata
			? `Bearer error="invalid_token", realm="MediaWiki MCP Server", resource_metadata="${metadataUrl}"`
			: `Bearer error="invalid_token", realm="MediaWiki MCP Server"`,
	);
	res.status(401).json({
		jsonrpc: '2.0',
		error: {
			code: AUTHENTICATION_REQUIRED_ERROR_CODE,
			message: 'Authentication required. See WWW-Authenticate header.',
		},
		...echoedId(req),
	});
}

// Refuses a request whose Basic credentials cannot be used: unreadable, or
// arriving at a deployment that does not accept them. The challenge advertises
// Basic only when the scheme is actually accepted — inviting a caller to retry
// with credentials this server would refuse again is a loop, and a browser shown
// that header pops a login dialog for a sign-in that cannot succeed.
function emit401Basic(req: Request, res: Response, message: string, advertise: boolean): void {
	if (advertise) {
		res.set('WWW-Authenticate', 'Basic realm="MediaWiki MCP Server", charset="UTF-8"');
	}
	res.status(401).json({
		jsonrpc: '2.0',
		error: { code: AUTHENTICATION_REQUIRED_ERROR_CODE, message },
		...echoedId(req),
	});
}

// Emitted when a proxy JWT is valid but its upstream token could not be refreshed
// because of a transient upstream failure. Unlike emit401Challenge this carries NO
// WWW-Authenticate header: the client should retry, not discard its session and
// re-authenticate.
function emit503Unavailable(req: Request, res: Response): void {
	res.status(503).json({
		jsonrpc: '2.0',
		error: {
			code: UPSTREAM_UNAVAILABLE_ERROR_CODE,
			message: 'Upstream authorization temporarily unavailable. Please retry.',
		},
		...echoedId(req),
	});
}

// One shared allowance for every caller-supplied bearer, charged alongside the
// per-token bucket. This server cannot verify those tokens, so without it a
// caller minting a random bearer per request would never meet a limit.
const PASSTHROUGH_SHARED_KEY = 'bearer:shared';

// The refusal that should be reported when two allowances are charged: a refusal
// beats an admission, and the longer wait beats the shorter.
function worstOf(a: RateLimitDecision, b: RateLimitDecision): RateLimitDecision {
	if (a.allowed) {
		return b;
	}
	if (b.allowed) {
		return a;
	}
	return a.retryAfterSeconds >= b.retryAfterSeconds ? a : b;
}

function emit429RateLimited(req: Request, res: Response, retryAfterSeconds: number): void {
	res.set('Retry-After', String(retryAfterSeconds));
	res.status(429).json({
		jsonrpc: '2.0',
		error: {
			code: RATE_LIMITED_ERROR_CODE,
			message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
		},
		...echoedId(req),
	});
}

// Only tools/call is limited: that is the request the spec's rate-limit
// requirement names, and it is the one that reaches the wiki. Discovery,
// initialize, cancellations and the held-open subscriptions/listen stream all
// pass untouched — a stream that consumed a token would hold it forever.
function isToolsCallMessage(message: unknown): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { method?: unknown }).method === 'tools/call'
	);
}

// How many tokens a request costs. The legacy stateless leg executes a JSON-RPC
// batch array entry by entry, so a batch must be charged per tools/call entry:
// counting the array as one request would let any caller wrap N calls in
// brackets and pay for one.
function toolsCallCost(body: unknown): number {
	if (Array.isArray(body)) {
		return body.filter(isToolsCallMessage).length;
	}
	return isToolsCallMessage(body) ? 1 : 0;
}

export interface McpRouteOptions {
	wikiRegistry?: WikiRegistry;
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
	// Reported when the Node adapter answers 500 because request conversion or
	// handler.fetch itself threw. Handler-internal errors surface through the
	// handler's own onerror instead.
	onerror?: (error: Error) => void;
	// Limits tools/call per authenticated caller (shared bucket for anonymous
	// traffic). Omitted when rate limiting is disabled (MCP_RATE_LIMIT=0).
	rateLimiter?: RateLimiter;
}

// Builds the /mcp route: per-request identity resolution — a bearer or the
// caller's own bot password — in front of the SDK's era-routing handler. The handler serves 2026-07-28 traffic per request and
// falls back to old-school stateless serving for 2025-era traffic, so this one
// route covers POST, GET, and DELETE — body-less GET/DELETE classify as legacy
// session operations and are answered 405 by the stateless fallback.
// Structurally typed on `fetch` so tests can substitute a capturing fake for
// the real handler.
export function createMcpRouteHandler(
	handler: Pick<McpHttpHandler, 'fetch'>,
	options: McpRouteOptions = {},
): RequestHandler {
	const { wikiRegistry, getProxyConfig, proxyStore, refresh, defaultWikiKey, rateLimiter } =
		options;
	const nodeHandler = toNodeHandler(handler, { onerror: options.onerror });
	return async (req, res) => {
		const bearer = extractBearerToken(req);
		const pc = getProxyConfig?.() ?? null;

		// Bot-password credentials the caller supplied. Read before anything else
		// looks at the header: a Basic value is not a bearer, so every branch below
		// would otherwise treat an authenticated caller as anonymous.
		const basic = readBasicAuthHeader(req);
		if (basic.kind === 'malformed') {
			emit401Basic(
				req,
				res,
				`The Authorization: Basic header could not be read: ${basic.reason}.`,
				basicAuthEnabled(),
			);
			return;
		}
		if (basic.kind === 'credentials' && !basicAuthEnabled()) {
			// Refused rather than ignored, for the same reason an unsolicited bearer
			// is: running the call anonymously would leave the caller believing it
			// acted as itself.
			emit401Basic(
				req,
				res,
				'This server does not accept Authorization: Basic credentials (MCP_ALLOW_BASIC_AUTH=false).',
				false,
			);
			return;
		}
		const credentials = basic.kind === 'credentials' ? basic.credentials : undefined;

		// A `private` wiki disallows anonymous reads, so the deployment requires
		// auth for everything: challenge any tokenless request up front — including
		// `initialize` — so an OAuth-capable client signs in at connect. This
		// connection-time 401 is the broadly client-compatible trigger.
		if (
			!bearer &&
			!credentials &&
			defaultWikiKey !== undefined &&
			wikiRegistry?.get(defaultWikiKey)?.private === true
		) {
			emit401Challenge(req, res, pc !== null);
			return;
		}

		// The token threaded into withRequestContext (and thus into mwn). For the
		// legacy path it is the raw request bearer. For the proxy path it is the
		// UPSTREAM wiki token resolved from the proxy JWT (or undefined for an
		// anonymous, tokenless request).
		let resolvedBearer = bearer;
		// Rate-limit key for the VERIFIED caller. Assigned only after the bearer
		// has been resolved, so an invalid bearer is 401'd and never mints a
		// bucket; anonymous traffic stays undefined and shares one bucket.
		let rateLimitKey: string | undefined;

		if (pc && proxyStore) {
			// Proxy enabled. A bearer is a proxy JWT: verify + resolve it to the
			// upstream wiki token. A 401 (with the discovery hint) is emitted only
			// when a bearer is present but invalid/expired/unresolvable — never for a
			// tokenless request, which is served anonymously (step-up for write tools
			// happens later in checkWikiCapability, not as a transport 401).
			if (bearer) {
				try {
					const resolved = await resolveUpstreamBearer(bearer, pc, proxyStore, refresh);
					resolvedBearer = resolved.accessToken;
					rateLimitKey = `user:${resolved.upstreamTokenId}`;
				} catch (err) {
					// A transient upstream refresh failure is retryable: answer 503 without a
					// re-auth challenge. Everything else (bad/expired JWT, dead refresh token)
					// is a genuine auth failure: emit the 401 discovery challenge.
					if (err instanceof UpstreamBearerError && err.retryable) {
						emit503Unavailable(req, res);
					} else {
						emit401Challenge(req, res, pc !== null);
					}
					return;
				}
			} else {
				resolvedBearer = undefined;
			}
		} else if (bearer && !bearerPassthroughEnabled()) {
			// Proxy disabled and forwarding not opted into. The bearer was issued by
			// the wiki's authorization server, not for this server, so it is refused
			// rather than forwarded: accepting a token minted for another audience is
			// what the passthrough prohibition is about, and silently ignoring it
			// would be worse — the caller would believe it is acting as itself while
			// the request ran anonymously or as a configured identity.
			//
			// Not conditioned on whether a wiki sets `oauth2ClientId`: that describes
			// how THIS server runs browser sign-in, not whether the wiki accepts
			// bearers. Any wiki with Extension:OAuth does, so a forwarded token would
			// authenticate as the caller there regardless of our own configuration.
			// A caller whose bearer is meant for something else is what the opt-in is
			// for; the server cannot tell the two apart and must not guess.
			emit401Challenge(req, res, pc !== null);
			return;
		} else if (!bearer && !credentials && wikiRegistry && bearerPassthroughEnabled()) {
			// Only meaningful while forwarding is available: a tokenless request to a
			// set of wikis that all require OAuth can be answered by the caller
			// supplying one. Without passthrough there is nothing a client can do, so
			// the condition is an operator misconfiguration rather than a 401.
			const all = Object.values(wikiRegistry.getAll());
			const fallbackAllowed = process.env.MCP_ALLOW_STATIC_FALLBACK === 'true';
			const allNeedAuth = all.length > 0 && all.every((cfg) => wikiNeedsAuth(cfg, fallbackAllowed));
			if (allNeedAuth) {
				emit401Challenge(req, res, pc !== null);
				return;
			}
		}

		// Basic callers get a bucket per USERNAME, not per credential pair: a login
		// name is one caller, and rotating its password must not hand it a fresh
		// allowance. The password is left out of the digest for that reason. A
		// resolved proxy identity, being verified, keeps precedence.
		if (rateLimitKey === undefined && credentials) {
			const digest = createHash('sha256').update(credentials.username).digest('hex').slice(0, 32);
			rateLimitKey = `basic:${digest}`;
		}

		// A bearer that survived to here outside the proxy path is being forwarded
		// under the deprecated opt-in. This server never verifies it, so a digest
		// of the token is the only identity available.
		let forwardedBearer = false;
		if (rateLimitKey === undefined && resolvedBearer !== undefined && !(pc && proxyStore)) {
			const digest = createHash('sha256').update(resolvedBearer).digest('hex').slice(0, 32);
			rateLimitKey = `bearer:${digest}`;
			forwardedBearer = true;
		}

		if (rateLimiter && req.method === 'POST') {
			const cost = toolsCallCost(req.body);
			if (cost > 0) {
				// An unverified bearer would otherwise mint a fresh allowance per
				// request: rotating random tokens rotates digests. Charging a shared
				// bucket as well caps the whole forwarding path, while the per-digest
				// bucket still keeps distinct legitimate callers apart. Refusing on
				// either leaves the other's token spent — an accounting slip that
				// only ever makes the limiter stricter under abuse.
				const decision = forwardedBearer
					? worstOf(
							rateLimiter.take(PASSTHROUGH_SHARED_KEY, cost),
							rateLimiter.take(rateLimitKey, cost),
						)
					: rateLimiter.take(rateLimitKey, cost);
				if (!decision.allowed) {
					recordRateLimited(decision.bucket);
					emit429RateLimited(req, res, decision.retryAfterSeconds);
					return;
				}
			}
		}

		await withRequestIdentity(
			{ runtimeToken: resolvedBearer, runtimeCredentials: credentials },
			() =>
				// express.json() has already drained the request stream, so the parsed
				// body is handed to the adapter. POST only: the SDK documents
				// parsedBody as absent for body-less methods, and express.json()
				// would hand GET/DELETE a spurious `{}`.
				nodeHandler(req, res, req.method === 'POST' ? req.body : undefined),
		);
	};
}
