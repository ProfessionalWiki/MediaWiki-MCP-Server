import {
	refreshTokens as defaultRefresh,
	classifyRefreshError,
	type RefreshArgs,
} from './oauthFlow.ts';
import type { ProxyConfig } from './authorizationServer/proxyConfig.ts';
import type { ProxyStore } from './authorizationServer/proxyStore.ts';
import { verifyAccessToken } from './authorizationServer/jwt.ts';
import { mwOauth2TokenEndpoint } from './mwOauth2Endpoints.ts';

// Refresh tokens within this window of expiry rather than waiting for an actual
// upstream 401, so the very next wiki call uses a fresh token.
const UPSTREAM_REFRESH_SKEW_MS = 30_000;

export type RefreshFn = (a: RefreshArgs) => Promise<{
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
		tokenEndpoint: mwOauth2TokenEndpoint(pc.tokenExchangeBase, pc.scriptpath),
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
