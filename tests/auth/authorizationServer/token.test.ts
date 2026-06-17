import { describe, it, expect, vi } from 'vitest';
import { handleToken } from '../../../src/auth/authorizationServer/token.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';
import { randomVerifier, s256 } from '../../../src/auth/pkce.js';
import {
	verifyAccessToken,
	mintRefreshToken,
	mintAccessToken,
} from '../../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../../src/auth/authorizationServer/proxyConfig.js';
import { OAuthFlowError } from '../../../src/auth/oauthFlow.js';

const pc: ProxyConfig = {
	issuer: 'https://wiki.example/mcp',
	authorizeBase: 'https://wiki.example',
	tokenExchangeBase: 'http://mediawiki.svc:80',
	scriptpath: '/w',
	callbackUrl: 'https://wiki.example/mcp/oauth/callback',
	upstreamClientId: 'UP',
	signingKey: 'k'.repeat(32),
	consentTtlMs: 1000,
	tokenTtlMs: 60_000,
};

const REDIRECT = 'http://127.0.0.1:9000/cb';

describe('handleToken authorization_code', () => {
	it('mints a proxy access token for a valid PKCE redemption', async () => {
		const store = new InMemoryProxyStore();
		const verifier = randomVerifier();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'WA',
			refreshToken: 'WR',
			expiresAt: Date.now() + 3.6e6,
		});
		store.putCode('CC', {
			clientId: 'cid',
			clientRedirectUri: REDIRECT,
			clientCodeChallenge: s256(verifier),
			scopes: ['editpage'],
			upstreamTokenId,
		});
		const r = await handleToken(
			{
				grant_type: 'authorization_code',
				code: 'CC',
				code_verifier: verifier,
				client_id: 'cid',
				redirect_uri: REDIRECT,
			},
			pc,
			store,
		);
		expect(r.status).toBe(200);
		expect(r.body.token_type).toBe('Bearer');
		expect(r.body.expires_in).toBe(60);
		expect(r.body.scope).toBe('editpage');
		expect(typeof r.body.refresh_token).toBe('string');
		const claims = await verifyAccessToken(r.body.access_token as string, pc);
		expect(claims.upstreamTokenId).toBe(upstreamTokenId);
		expect(claims.scopes).toEqual(['editpage']);
	});

	it('rejects a wrong verifier', async () => {
		const store = new InMemoryProxyStore();
		store.putCode('CC', {
			clientId: 'cid',
			clientRedirectUri: 'r',
			clientCodeChallenge: s256(randomVerifier()),
			scopes: [],
			upstreamTokenId: 'u',
		});
		const r = await handleToken(
			{ grant_type: 'authorization_code', code: 'CC', code_verifier: 'wrong' },
			pc,
			store,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('rejects a reused/unknown code', async () => {
		const store = new InMemoryProxyStore();
		const r = await handleToken(
			{ grant_type: 'authorization_code', code: 'nope', code_verifier: 'x' },
			pc,
			store,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('rejects a redemption whose client_id does not match the code, and burns the code', async () => {
		const store = new InMemoryProxyStore();
		const verifier = randomVerifier();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'WA',
			refreshToken: 'WR',
			expiresAt: Date.now() + 3.6e6,
		});
		store.putCode('CC', {
			clientId: 'cid',
			clientRedirectUri: REDIRECT,
			clientCodeChallenge: s256(verifier),
			scopes: [],
			upstreamTokenId,
		});
		const r = await handleToken(
			{
				grant_type: 'authorization_code',
				code: 'CC',
				code_verifier: verifier,
				client_id: 'WRONG',
				redirect_uri: REDIRECT,
			},
			pc,
			store,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
		// The one-time code was consumed even on the mismatched attempt, so a
		// subsequent correct redemption also fails.
		const r2 = await handleToken(
			{
				grant_type: 'authorization_code',
				code: 'CC',
				code_verifier: verifier,
				client_id: 'cid',
				redirect_uri: REDIRECT,
			},
			pc,
			store,
		);
		expect(r2.body.error).toBe('invalid_grant');
	});

	it('rejects a redemption whose redirect_uri does not match the code', async () => {
		const store = new InMemoryProxyStore();
		const verifier = randomVerifier();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'WA',
			refreshToken: 'WR',
			expiresAt: Date.now() + 3.6e6,
		});
		store.putCode('CC', {
			clientId: 'cid',
			clientRedirectUri: REDIRECT,
			clientCodeChallenge: s256(verifier),
			scopes: [],
			upstreamTokenId,
		});
		const r = await handleToken(
			{
				grant_type: 'authorization_code',
				code: 'CC',
				code_verifier: verifier,
				client_id: 'cid',
				redirect_uri: 'http://evil.example/cb',
			},
			pc,
			store,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('rejects unsupported grant_type', async () => {
		const store = new InMemoryProxyStore();
		const r = await handleToken({ grant_type: 'password' }, pc, store);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('unsupported_grant_type');
	});
});

describe('handleToken refresh_token', () => {
	// Helper: stage an upstream token plus a matching, current refresh JWT.
	async function stage(
		store: InMemoryProxyStore,
		upstream: { accessToken: string; refreshToken?: string; expiresAt: number },
	): Promise<{ upstreamTokenId: string; rt: string }> {
		const upstreamTokenId = store.putUpstreamToken(upstream);
		store.setRefreshId(upstreamTokenId, 'RID0');
		const rt = await mintRefreshToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId,
			refreshId: 'RID0',
			ttlMs: 60_000,
		});
		return { upstreamTokenId, rt };
	}

	it('refreshes upstream and re-mints', async () => {
		const store = new InMemoryProxyStore();
		const { upstreamTokenId, rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const refresh = vi
			.fn()
			.mockResolvedValue({ access_token: 'NEW', refresh_token: 'WR2', expires_in: 3600 });
		const r = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r.status).toBe(200);
		expect(refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: 'http://mediawiki.svc:80/w/rest.php/oauth2/access_token',
				refreshToken: 'WR',
				clientId: 'UP',
			}),
		);
		expect(store.getUpstreamToken(upstreamTokenId)?.accessToken).toBe('NEW');
		expect(store.getUpstreamToken(upstreamTokenId)?.refreshToken).toBe('WR2');
		const claims = await verifyAccessToken(r.body.access_token as string, pc);
		expect(claims.upstreamTokenId).toBe(upstreamTokenId);
	});

	it('rotates the refresh token; replaying the old one is rejected and revokes the family', async () => {
		const store = new InMemoryProxyStore();
		const { upstreamTokenId, rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const refresh = vi
			.fn()
			.mockResolvedValue({ access_token: 'NEW', refresh_token: 'WR2', expires_in: 3600 });

		const r1 = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r1.status).toBe(200);
		const rotated = r1.body.refresh_token as string;
		expect(rotated).not.toBe(rt);

		// Replaying the ORIGINAL refresh token (now superseded) is rejected and the
		// whole upstream token is revoked.
		const r2 = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r2.status).toBe(400);
		expect(r2.body.error).toBe('invalid_grant');
		expect(store.getUpstreamToken(upstreamTokenId)).toBeUndefined();
	});

	it('detects concurrent reuse of the same refresh token and revokes the family', async () => {
		const store = new InMemoryProxyStore();
		const { upstreamTokenId, rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		// Slow upstream refresh so both requests are genuinely in flight at once.
		const refresh = vi
			.fn()
			.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ access_token: 'NEW', refresh_token: 'WR2', expires_in: 3600 }),
							15,
						),
					),
			);
		const [a, b] = await Promise.all([
			handleToken({ grant_type: 'refresh_token', refresh_token: rt }, pc, store, refresh),
			handleToken({ grant_type: 'refresh_token', refresh_token: rt }, pc, store, refresh),
		]);
		// Exactly one is accepted; the concurrent reuse is rejected and revokes the family.
		expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 400]);
		expect(store.getUpstreamToken(upstreamTokenId)).toBeUndefined();
	});

	it('rejects an invalid refresh token', async () => {
		const store = new InMemoryProxyStore();
		const r = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: 'not-a-jwt' },
			pc,
			store,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('rejects when there is no stored upstream refresh token', async () => {
		const store = new InMemoryProxyStore();
		const { rt } = await stage(store, { accessToken: 'OLD', expiresAt: Date.now() });
		const r = await handleToken({ grant_type: 'refresh_token', refresh_token: rt }, pc, store);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('returns invalid_grant when the upstream refresh fails', async () => {
		const store = new InMemoryProxyStore();
		const { upstreamTokenId, rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const refresh = vi.fn().mockRejectedValue(new Error('boom'));
		const r = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
		expect(store.getUpstreamToken(upstreamTokenId)?.accessToken).toBe('OLD');
	});

	it('maps a transient upstream refresh failure to 503 and keeps the upstream token', async () => {
		const store = new InMemoryProxyStore();
		const { upstreamTokenId, rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('transient', 'boom'));
		const r = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r.status).toBe(503);
		expect(r.body.error).toBe('temporarily_unavailable');
		// The refresh token must NOT be discarded: the stored upstream token is intact.
		expect(store.getUpstreamToken(upstreamTokenId)?.accessToken).toBe('OLD');
		expect(store.getUpstreamToken(upstreamTokenId)?.refreshToken).toBe('WR');
	});

	it('maps an upstream invalid_grant to 400 invalid_grant', async () => {
		const store = new InMemoryProxyStore();
		const { rt } = await stage(store, {
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('invalid_grant', 'dead'));
		const r = await handleToken(
			{ grant_type: 'refresh_token', refresh_token: rt },
			pc,
			store,
			refresh,
		);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('rejects an access token presented to the refresh grant', async () => {
		const store = new InMemoryProxyStore();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const at = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId,
			ttlMs: 60_000,
			scopes: ['editpage'],
		});
		const r = await handleToken({ grant_type: 'refresh_token', refresh_token: at }, pc, store);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});
});
