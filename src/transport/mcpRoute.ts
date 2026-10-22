import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { hasStaticCredentials, usesOAuthSignIn, type AuthPolicy } from '../runtime/authShape.ts';
import type { Metrics } from '../runtime/metrics.ts';
import { withRequestContext, type RuntimeToken } from '../runtime/requestContext.ts';
import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import { resolvePublicBase } from '../auth/protectedResource.ts';
import {
	AUTHENTICATION_REQUIRED_ERROR_CODE,
	RATE_LIMITED_ERROR_CODE,
	UPSTREAM_UNAVAILABLE_ERROR_CODE,
} from './errorCodes.ts';
import { sendJsonRpcError } from './jsonRpcError.ts';
import type { RateLimitDecision, RateLimiter } from './rateLimit.ts';
import type { HostedProxy } from '../auth/authorizationServer/hostedProxy.ts';
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

// Honours a trusted reverse proxy's x-forwarded-proto.
export function resolveRequestProto(req: Request): 'http' | 'https' {
	const protoHeader = req.headers['x-forwarded-proto'];
	const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() : undefined;
	return proto === 'https' || proto === 'http' ? proto : req.secure ? 'https' : 'http';
}

// A wiki needs auth when it is OAuth-only with no usable static fallback.
function wikiNeedsAuth(cfg: WikiConfig, fallbackAllowed: boolean): boolean {
	if (!usesOAuthSignIn(cfg)) {
		return false;
	}
	const hasStatic = hasStaticCredentials(cfg);
	return !(hasStatic && fallbackAllowed);
}

// The SDK's rule: only a single request object with a string method has an id to echo.
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

// `hasMetadata`: whether this server serves a protected-resource document. A
// client pointed at one that 404s is stranded; RFC 6750 allows leaving it out.
function emit401Challenge(req: Request, res: Response, hasMetadata: boolean): void {
	const requestProto = resolveRequestProto(req);
	const base = resolvePublicBase(req.headers.host ?? undefined, requestProto);
	// The document is at the origin root (RFC 9728), and the SDK fetches this URL as given.
	const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(base)?.[0] ?? base.replace(/\/+$/, '');
	const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
	res.set(
		'WWW-Authenticate',
		hasMetadata
			? `Bearer error="invalid_token", realm="MediaWiki MCP Server", resource_metadata="${metadataUrl}"`
			: `Bearer error="invalid_token", realm="MediaWiki MCP Server"`,
	);
	sendJsonRpcError(
		res,
		401,
		{
			code: AUTHENTICATION_REQUIRED_ERROR_CODE,
			message: 'Authentication required. See WWW-Authenticate header.',
		},
		echoableRequestId(req.body),
	);
}

// No WWW-Authenticate: the client should retry, not sign in again.
function emit503Unavailable(req: Request, res: Response): void {
	sendJsonRpcError(
		res,
		503,
		{
			code: UPSTREAM_UNAVAILABLE_ERROR_CODE,
			message: 'Upstream authorization temporarily unavailable. Please retry.',
		},
		echoableRequestId(req.body),
	);
}

// Forwarded bearers are unverified, so a fresh random one per request would
// otherwise never meet a limit.
const PASSTHROUGH_SHARED_KEY = 'bearer:shared';

// A refusal beats an admission, and the longer wait beats the shorter.
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
	sendJsonRpcError(
		res,
		429,
		{
			code: RATE_LIMITED_ERROR_CODE,
			message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
		},
		echoableRequestId(req.body),
	);
}

// Only tools/call reaches the wiki; a held-open listen stream would keep its token.
function isToolsCallMessage(message: unknown): boolean {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { method?: unknown }).method === 'tools/call'
	);
}

// The legacy leg runs a batch entry by entry, so each tools/call entry pays.
function toolsCallCost(body: unknown): number {
	if (Array.isArray(body)) {
		return body.filter(isToolsCallMessage).length;
	}
	return isToolsCallMessage(body) ? 1 : 0;
}

export interface McpRouteOptions {
	auth: AuthPolicy;
	wikiRegistry?: WikiRegistry;
	// Tests only.
	refresh?: RefreshFn;
	// When it is `private`, a tokenless request is refused at connect.
	defaultWikiKey?: string;
	// For a 500 from the Node adapter; the handler reports its own errors.
	onerror?: (error: Error) => void;
	// Absent when MCP_RATE_LIMIT=0.
	rateLimiter?: RateLimiter;
	metrics: Metrics;
}

/** Who a request to /mcp acts as, or why it is refused before it reaches the server. */
type Caller = AdmittedCaller | { refusal: 'unauthenticated' | 'unavailable' };

interface AdmittedCaller {
	token?: RuntimeToken;
	/** Absent for anonymous callers, who share one bucket. */
	rateLimitKey?: string;
}

const ANONYMOUS: AdmittedCaller = {};
const UNAUTHENTICATED: Caller = { refusal: 'unauthenticated' };

async function resolveCaller(
	bearer: string | undefined,
	options: McpRouteOptions,
): Promise<Caller> {
	const { wikiRegistry, defaultWikiKey, refresh, auth } = options;

	// Challenged at `initialize` too, so a client signs in when it connects.
	if (
		!bearer &&
		defaultWikiKey !== undefined &&
		wikiRegistry?.get(defaultWikiKey)?.private === true
	) {
		return UNAUTHENTICATED;
	}

	// A tokenless caller is asked to sign in only by a write, in checkWikiCapability.
	// With the hosted proxy, a bearer is a proxy JWT standing for a stored wiki token.
	if (auth.hostedProxy) {
		return bearer ? signedInCaller(bearer, auth.hostedProxy, refresh) : ANONYMOUS;
	}

	// A bearer here was issued for the wiki, not for this server, so it is
	// refused rather than ignored, whatever the wikis' `oauth2ClientId`.
	if (!auth.bearerPassthrough) {
		return bearer ? UNAUTHENTICATED : ANONYMOUS;
	}
	if (bearer) {
		return forwardedCaller(bearer);
	}

	// A 401 only helps while the caller can answer it by forwarding a token.
	return wikiRegistry && everyWikiNeedsAuth(wikiRegistry, auth.staticFallback)
		? UNAUTHENTICATED
		: ANONYMOUS;
}

async function signedInCaller(
	bearer: string,
	proxy: HostedProxy,
	refresh: RefreshFn | undefined,
): Promise<Caller> {
	try {
		const resolved = await resolveUpstreamBearer(bearer, proxy.config, proxy.store, refresh);
		return {
			token: { value: resolved.accessToken, wikiKey: proxy.config.wikiKey },
			rateLimitKey: `user:${resolved.upstreamTokenId}`,
		};
	} catch (err) {
		// A transient refresh failure asks the client to retry, not to sign in again.
		return err instanceof UpstreamBearerError && err.retryable
			? { refusal: 'unavailable' }
			: UNAUTHENTICATED;
	}
}

// Never verified, so the token's digest is its only identity.
function forwardedCaller(bearer: string): AdmittedCaller {
	const digest = createHash('sha256').update(bearer).digest('hex').slice(0, 32);
	return { token: { value: bearer, wikiKey: null }, rateLimitKey: `bearer:${digest}` };
}

function everyWikiNeedsAuth(wikiRegistry: WikiRegistry, staticFallback: boolean): boolean {
	const all = Object.values(wikiRegistry.getAll());
	return all.length > 0 && all.every((cfg) => wikiNeedsAuth(cfg, staticFallback));
}

// Serves POST, GET and DELETE: the SDK handler falls back to stateless serving
// for 2025-era traffic, which answers GET and DELETE with 405.
export function createMcpRouteHandler(
	handler: Pick<McpHttpHandler, 'fetch'>,
	options: McpRouteOptions,
): RequestHandler {
	const { auth, rateLimiter, metrics } = options;
	const nodeHandler = toNodeHandler(handler, { onerror: options.onerror });
	return async (req, res) => {
		const caller = await resolveCaller(extractBearerToken(req), options);
		if ('refusal' in caller) {
			if (caller.refusal === 'unavailable') {
				emit503Unavailable(req, res);
			} else {
				emit401Challenge(req, res, auth.hostedProxy !== null);
			}
			return;
		}

		if (rateLimiter && req.method === 'POST') {
			const cost = toolsCallCost(req.body);
			if (cost > 0) {
				// Rotating tokens rotates digests, so forwarded bearers also share a bucket.
				const decision =
					caller.token?.wikiKey === null
						? worstOf(
								rateLimiter.take(PASSTHROUGH_SHARED_KEY, cost),
								rateLimiter.take(caller.rateLimitKey, cost),
							)
						: rateLimiter.take(caller.rateLimitKey, cost);
				if (!decision.allowed) {
					metrics.recordRateLimited(decision.bucket);
					emit429RateLimited(req, res, decision.retryAfterSeconds);
					return;
				}
			}
		}

		await withRequestContext(caller.token, () =>
			// express.json() has drained the stream; GET and DELETE get no body, not its `{}`.
			nodeHandler(req, res, req.method === 'POST' ? req.body : undefined),
		);
	};
}
