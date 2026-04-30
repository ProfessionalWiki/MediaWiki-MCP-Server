// tests/auth/oauthFlow.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { exchangeCode, OAuthFlowError, refreshTokens } from '../../src/auth/oauthFlow.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';

let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
});

describe('exchangeCode', () => {
	it('returns a TokenResponse on success', async () => {
		fakeAs = await startFakeAs();
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		const result = await exchangeCode({
			tokenEndpoint,
			code: 'mycode',
			verifier: 'myverifier',
			clientId: 'client-abc',
			redirectUri: 'http://localhost/callback',
		});
		expect(result.access_token).toBe('access-mycode');
		expect(result.refresh_token).toBe('refresh-mycode');
		expect(result.expires_in).toBe(3600);
		expect(result.scope).toBe('edit');
		expect(result.token_type).toBe('Bearer');
	});

	it('throws OAuthFlowError(invalid_grant) on 400 invalid_grant', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_grant' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'bad',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'invalid_grant' });
	});

	it('throws OAuthFlowError(invalid_client) on 400 invalid_client', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_client' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'bad-client',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'invalid_client' });
	});

	it('throws OAuthFlowError(transient) on 500', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(500).end();
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'transient' });
	});

	it('throws OAuthFlowError(malformed) when access_token missing', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.json({ expires_in: 3600 });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'malformed' });
	});

	it('throws OAuthFlowError(malformed) when expires_in missing', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.json({ access_token: 'tok' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'malformed' });
	});

	it('throws OAuthFlowError(transient) for network error', async () => {
		// Point at a port that is not listening
		await expect(
			exchangeCode({
				tokenEndpoint: 'http://127.0.0.1:1/token',
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'transient' });
	});

	it('throws OAuthFlowError(transient) for other 400 error codes', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'unsupported_grant_type' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toMatchObject({ kind: 'transient' });
	});

	it('throws instances of OAuthFlowError', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_grant' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			exchangeCode({
				tokenEndpoint,
				code: 'c',
				verifier: 'v',
				clientId: 'c',
				redirectUri: 'http://localhost/callback',
			}),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});
});

describe('refreshTokens', () => {
	it('returns a TokenResponse on success', async () => {
		fakeAs = await startFakeAs();
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		const result = await refreshTokens({
			tokenEndpoint,
			refreshToken: 'old-refresh',
			clientId: 'client-abc',
		});
		expect(result.access_token).toBe('access-refreshed');
		expect(result.refresh_token).toBe('refresh-rotated');
		expect(result.expires_in).toBe(3600);
	});

	it('throws OAuthFlowError(invalid_grant) on 400 invalid_grant', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_grant' });
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			refreshTokens({ tokenEndpoint, refreshToken: 'expired', clientId: 'c' }),
		).rejects.toMatchObject({ kind: 'invalid_grant' });
	});

	it('throws OAuthFlowError(transient) on 503', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(503).end();
			},
		});
		const tokenEndpoint = `${fakeAs.url}/w/rest.php/oauth2/access_token`;
		await expect(
			refreshTokens({ tokenEndpoint, refreshToken: 'r', clientId: 'c' }),
		).rejects.toMatchObject({ kind: 'transient' });
	});
});
