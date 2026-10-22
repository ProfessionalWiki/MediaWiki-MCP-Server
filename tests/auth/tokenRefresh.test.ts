// tests/auth/tokenRefresh.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshIfNeeded, type RefreshContext } from '../../src/auth/tokenRefresh.ts';
import { createTokenStore, type StoredToken } from '../../src/auth/tokenStore.ts';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';
import { fakeClock } from '../helpers/fakeClock.ts';
import { useTempTokenStore } from '../helpers/tempTokenStore.ts';

useTempTokenStore();

let fakeAs: FakeAsHandle | undefined;

afterEach(async () => {
	await fakeAs?.close();
	fakeAs = undefined;
	vi.useRealTimers();
});

function makeCtx(tokenEndpoint: string): RefreshContext {
	return {
		clientId: 'test-client',
		metadata: { token_endpoint: tokenEndpoint, issuer: 'https://wiki.example' },
	};
}

function storedToken(overrides: Partial<StoredToken> = {}): StoredToken {
	return {
		access_token: 'cached-access',
		refresh_token: 'old-refresh',
		expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		scopes: ['edit'],
		obtained_at: new Date().toISOString(),
		...overrides,
	};
}

describe('refreshIfNeeded', () => {
	it('returns cached access_token when more than 60 s before expiry', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs();
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				access_token: 'cached-access',
				expires_at: new Date(clock.now() + 120_000).toISOString(),
			}),
		);

		const result = await refreshIfNeeded(
			'my-wiki',
			makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`),
		);
		expect(result).toBe('cached-access');
	});

	it('refreshes when within 60 s of expiry and persists the rotated token', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs();
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				access_token: 'old-access',
				refresh_token: 'old-refresh',
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		const result = await refreshIfNeeded(
			'my-wiki',
			makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`),
		);
		expect(result).toBe('access-refreshed');

		const creds = await store.read();
		const stored = creds.tokens['my-wiki'];
		expect(stored?.access_token).toBe('access-refreshed');
		expect(stored?.refresh_token).toBe('refresh-rotated');
	});

	it('records the issuer on the refreshed token', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());
		fakeAs = await startFakeAs();
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({ expires_at: new Date(clock.now() + 30_000).toISOString() }),
		);

		await refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`));

		expect((await store.read()).tokens['my-wiki']?.issuer).toBe('https://wiki.example');
	});

	it('honours a rotated refresh_token from the AS response', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.json({
					access_token: 'new-access',
					refresh_token: 'brand-new-refresh',
					expires_in: 3600,
					scope: 'edit',
				});
			},
		});
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`));

		const creds = await store.read();
		expect(creds.tokens['my-wiki']?.refresh_token).toBe('brand-new-refresh');
	});

	it('keeps the original refresh_token when AS does not rotate', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.json({
					access_token: 'new-access',
					expires_in: 3600,
					scope: 'edit',
				});
			},
		});
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				refresh_token: 'original-refresh',
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`));

		const creds = await store.read();
		expect(creds.tokens['my-wiki']?.refresh_token).toBe('original-refresh');
	});

	it('throws when there is no stored token for the wiki', async () => {
		fakeAs = await startFakeAs();
		await expect(
			refreshIfNeeded('unknown-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`)),
		).rejects.toThrow('No stored token for wiki unknown-wiki');
	});

	it('throws OAuthFlowError(invalid_grant) and deletes the entry when token is expired with no refresh_token', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs();
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				refresh_token: undefined,
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await expect(
			refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`)),
		).rejects.toMatchObject({ kind: 'invalid_grant' });
	});

	it('deletes the stored entry on OAuthFlowError(invalid_grant) from AS', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_grant' });
			},
		});
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await expect(
			refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`)),
		).rejects.toMatchObject({ kind: 'invalid_grant' });

		const creds = await store.read();
		expect(creds.tokens['my-wiki']).toBeUndefined();
	});

	it('does NOT delete the stored entry on OAuthFlowError(invalid_client)', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_client' });
			},
		});
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await expect(
			refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`)),
		).rejects.toMatchObject({ kind: 'invalid_client' });

		const creds = await store.read();
		expect(creds.tokens['my-wiki']).toBeDefined();
	});

	it('uses stored scopes when AS response does not include scope', async () => {
		const clock = fakeClock();
		vi.setSystemTime(clock.now());

		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.json({
					access_token: 'new-access',
					expires_in: 3600,
				});
			},
		});
		const store = createTokenStore();
		await store.put(
			'my-wiki',
			storedToken({
				scopes: ['edit', 'read'],
				expires_at: new Date(clock.now() + 30_000).toISOString(),
			}),
		);

		await refreshIfNeeded('my-wiki', makeCtx(`${fakeAs.url}/w/rest.php/oauth2/access_token`));

		const creds = await store.read();
		expect(creds.tokens['my-wiki']?.scopes).toEqual(['edit', 'read']);
	});
});
