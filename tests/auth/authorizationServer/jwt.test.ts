import { describe, it, expect } from 'vitest';
import * as jwt from '../../../src/auth/authorizationServer/jwt.js';

const key = 'k'.repeat(32);
const issuer = 'https://wiki.example/mcp';

describe('proxy jwt', () => {
	it('mints and verifies an access token', async () => {
		const t = await jwt.mintAccessToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
			scopes: ['editpage'],
		});
		const claims = await jwt.verifyAccessToken(t, { issuer, signingKey: key });
		expect(claims.upstreamTokenId).toBe('u1');
		expect(claims.scopes).toEqual(['editpage']);
	});

	it('rejects a tampered/wrong-key token', async () => {
		const t = await jwt.mintAccessToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
			scopes: [],
		});
		await expect(
			jwt.verifyAccessToken(t, { issuer, signingKey: 'x'.repeat(32) }),
		).rejects.toThrow();
	});

	it('rejects a token with the wrong audience/issuer', async () => {
		const t = await jwt.mintAccessToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
			scopes: [],
		});
		await expect(
			jwt.verifyAccessToken(t, { issuer: 'https://other.example/mcp', signingKey: key }),
		).rejects.toThrow();
	});

	it('rejects an expired access token', async () => {
		const t = await jwt.mintAccessToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: -60_000,
			scopes: [],
		});
		await expect(jwt.verifyAccessToken(t, { issuer, signingKey: key })).rejects.toThrow();
	});

	it('round-trips a refresh token', async () => {
		const r = await jwt.mintRefreshToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
		});
		const claims = await jwt.verifyRefreshToken(r, { issuer, signingKey: key });
		expect(claims.upstreamTokenId).toBe('u1');
	});

	it('refuses a refresh token at the access verifier', async () => {
		const r = await jwt.mintRefreshToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
		});
		await expect(jwt.verifyAccessToken(r, { issuer, signingKey: key })).rejects.toThrow();
	});

	it('refuses an access token at the refresh verifier', async () => {
		const t = await jwt.mintAccessToken({
			issuer,
			signingKey: key,
			upstreamTokenId: 'u1',
			ttlMs: 60_000,
			scopes: [],
		});
		await expect(jwt.verifyRefreshToken(t, { issuer, signingKey: key })).rejects.toThrow();
	});

	it('round-trips a consent cookie and rejects mismatches', async () => {
		const c = await jwt.signConsent({
			clientId: 'cid',
			redirectHost: '127.0.0.1',
			wiki: 'w',
			ttlMs: 60_000,
			signingKey: key,
		});
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'cid',
				redirectHost: '127.0.0.1',
				wiki: 'w',
				signingKey: key,
			}),
		).toBe(true);
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'OTHER',
				redirectHost: '127.0.0.1',
				wiki: 'w',
				signingKey: key,
			}),
		).toBe(false);
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'cid',
				redirectHost: 'evil.example',
				wiki: 'w',
				signingKey: key,
			}),
		).toBe(false);
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'cid',
				redirectHost: '127.0.0.1',
				wiki: 'OTHER',
				signingKey: key,
			}),
		).toBe(false);
	});

	it('rejects a consent cookie signed with the wrong key', async () => {
		const c = await jwt.signConsent({
			clientId: 'cid',
			redirectHost: '127.0.0.1',
			wiki: 'w',
			ttlMs: 60_000,
			signingKey: key,
		});
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'cid',
				redirectHost: '127.0.0.1',
				wiki: 'w',
				signingKey: 'x'.repeat(32),
			}),
		).toBe(false);
	});

	it('rejects an expired consent cookie', async () => {
		const c = await jwt.signConsent({
			clientId: 'cid',
			redirectHost: '127.0.0.1',
			wiki: 'w',
			ttlMs: -60_000,
			signingKey: key,
		});
		expect(
			await jwt.verifyConsent(c, {
				clientId: 'cid',
				redirectHost: '127.0.0.1',
				wiki: 'w',
				signingKey: key,
			}),
		).toBe(false);
	});
});
