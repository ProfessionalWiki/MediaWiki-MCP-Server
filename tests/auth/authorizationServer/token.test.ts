import { describe, it, expect, vi } from 'vitest';
import { handleToken } from '../../../src/auth/authorizationServer/token.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';
import { randomVerifier, s256 } from '../../../src/auth/pkce.js';
import { verifyAccessToken, mintRefreshToken } from '../../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../../src/auth/authorizationServer/proxyConfig.js';

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
			clientRedirectUri: 'http://127.0.0.1:9000/cb',
			clientCodeChallenge: s256(verifier),
			scopes: ['editpage'],
			upstreamTokenId,
		});
		const r = await handleToken(
			{ grant_type: 'authorization_code', code: 'CC', code_verifier: verifier },
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

	it('rejects unsupported grant_type', async () => {
		const store = new InMemoryProxyStore();
		const r = await handleToken({ grant_type: 'password' }, pc, store);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('unsupported_grant_type');
	});
});

describe('handleToken refresh_token', () => {
	it('refreshes upstream and re-mints', async () => {
		const store = new InMemoryProxyStore();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const rt = await mintRefreshToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId,
			ttlMs: 60_000,
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
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'OLD',
			expiresAt: Date.now(),
		});
		const rt = await mintRefreshToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId,
			ttlMs: 60_000,
		});
		const r = await handleToken({ grant_type: 'refresh_token', refresh_token: rt }, pc, store);
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_grant');
	});

	it('returns invalid_grant when the upstream refresh fails', async () => {
		const store = new InMemoryProxyStore();
		const upstreamTokenId = store.putUpstreamToken({
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now(),
		});
		const rt = await mintRefreshToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId,
			ttlMs: 60_000,
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
});
