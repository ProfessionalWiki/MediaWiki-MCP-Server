import type { ProxyConfig } from './proxyConfig.js';
import type { ProxyStore } from './proxyStore.js';
import { s256 } from '../pkce.js';
import { mintAccessToken, mintRefreshToken, verifyRefreshToken } from './jwt.js';
import { refreshTokens as defaultRefresh, OAuthFlowError } from '../oauthFlow.js';

type RefreshFn = typeof defaultRefresh;

export interface TokenResult {
	status: number;
	body: Record<string, unknown>;
}

// Lifetime of the proxy-minted refresh JWT. Kept independent of the access-token
// TTL: the refresh JWT only carries the upstreamTokenId, and the actual upstream
// refresh window is enforced by the wiki (resolveProxyConfig caps the access TTL
// against it). 30 days gives clients a usable refresh horizon.
const REFRESH_JWT_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Pure handler for the proxy's RFC 6749 token endpoint (POST /mcp/token).
 *
 * - `authorization_code`: verifies the downstream client's PKCE (s256 of the
 *   submitted code_verifier must equal the challenge stored when the code was
 *   minted), consumes the one-time code, and mints a proxy access/refresh JWT
 *   pair keyed to the stored upstream token id.
 * - `refresh_token`: verifies the proxy refresh JWT, refreshes the upstream
 *   token server-to-server on the internal tokenExchangeBase, updates the stored
 *   upstream token, and re-mints a fresh proxy pair.
 *
 * `refresh` is injectable for testing; production passes the real refreshTokens.
 */
export async function handleToken(
	body: Record<string, string>,
	pc: ProxyConfig,
	store: ProxyStore,
	refresh: RefreshFn = defaultRefresh,
): Promise<TokenResult> {
	const bad = (e: string, d: string): TokenResult => ({
		status: 400,
		body: { error: e, error_description: d },
	});

	if (body.grant_type === 'authorization_code') {
		const rec = body.code ? store.consumeCode(body.code) : undefined;
		if (!rec) {
			return bad('invalid_grant', 'unknown or used code');
		}
		if (!body.code_verifier || s256(body.code_verifier) !== rec.clientCodeChallenge) {
			return bad('invalid_grant', 'PKCE verification failed');
		}
		return mintPair(pc, rec.upstreamTokenId, rec.scopes);
	}

	if (body.grant_type === 'refresh_token') {
		let claims: { upstreamTokenId: string };
		try {
			claims = await verifyRefreshToken(body.refresh_token ?? '', pc);
		} catch {
			return bad('invalid_grant', 'bad refresh token');
		}
		const upstream = store.getUpstreamToken(claims.upstreamTokenId);
		if (!upstream?.refreshToken) {
			return bad('invalid_grant', 'no upstream refresh token');
		}
		let refreshed;
		try {
			// Server-to-server on the INTERNAL tokenExchangeBase, exactly as the
			// /oauth/callback exchange does — distinct from the public authorizeBase.
			refreshed = await refresh({
				tokenEndpoint: `${pc.tokenExchangeBase}${pc.scriptpath}/rest.php/oauth2/access_token`,
				refreshToken: upstream.refreshToken,
				clientId: pc.upstreamClientId,
			});
		} catch (err) {
			// Transient/malformed upstream failures (wiki 5xx, network blip, garbled
			// response) are not the client's fault: surface a retryable 503 rather
			// than invalid_grant, which would tell an RFC 6749 client to DISCARD its
			// refresh token and force a full re-auth. invalid_grant/invalid_client
			// (the upstream genuinely rejecting the refresh token) still map to 400.
			if (err instanceof OAuthFlowError && (err.kind === 'transient' || err.kind === 'malformed')) {
				return {
					status: 503,
					body: {
						error: 'temporarily_unavailable',
						error_description: 'upstream refresh temporarily unavailable',
					},
				};
			}
			return bad('invalid_grant', 'upstream refresh failed');
		}
		store.updateUpstreamToken(claims.upstreamTokenId, {
			accessToken: refreshed.access_token,
			// Rotate the upstream refresh token when the wiki returns a new one;
			// otherwise keep the existing one so the next refresh still works.
			refreshToken: refreshed.refresh_token ?? upstream.refreshToken,
			expiresAt: Date.now() + refreshed.expires_in * 1000,
		});
		// The re-minted access token deliberately carries an empty scope. The proxy
		// JWT's `scope` claim is purely informational — real authorization is the
		// upstream wiki token referenced by `jti`, which we just refreshed. The
		// original grant's scopes are not persisted on the upstream-token record, so
		// they are not available here. Re-attaching them (and enforcing scopes) is a
		// follow-up for when/if scope enforcement lands.
		return mintPair(pc, claims.upstreamTokenId, []);
	}

	return bad('unsupported_grant_type', `unsupported grant_type: ${body.grant_type}`);
}

async function mintPair(
	pc: ProxyConfig,
	upstreamTokenId: string,
	scopes: string[],
): Promise<TokenResult> {
	const access_token = await mintAccessToken({
		issuer: pc.issuer,
		signingKey: pc.signingKey,
		upstreamTokenId,
		ttlMs: pc.tokenTtlMs,
		scopes,
	});
	const refresh_token = await mintRefreshToken({
		issuer: pc.issuer,
		signingKey: pc.signingKey,
		upstreamTokenId,
		ttlMs: REFRESH_JWT_TTL_MS,
	});
	return {
		status: 200,
		body: {
			access_token,
			token_type: 'Bearer',
			expires_in: Math.floor(pc.tokenTtlMs / 1000),
			refresh_token,
			scope: scopes.join(' '),
		},
	};
}
