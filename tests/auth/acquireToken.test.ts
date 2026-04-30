// tests/auth/acquireToken.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireToken } from '../../src/auth/acquireToken.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';
import { useTempTokenStore } from '../helpers/tempTokenStore.js';
import { createTokenStore } from '../../src/auth/tokenStore.js';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.js';
import { _resetBrowserAuthDedupForTesting } from '../../src/auth/browserAuth.js';
import { _resetRefreshDedupForTesting } from '../../src/auth/tokenRefresh.js';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.js';

vi.mock('open', () => ({ default: vi.fn() }));
import openMod from 'open';

useTempTokenStore();
let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
	_resetBrowserAuthDedupForTesting();
	_resetRefreshDedupForTesting();
	vi.clearAllMocks();
});

function makeWiki(url: string) {
	return { server: url, scriptpath: '/w' };
}

function futureIso(deltaMs: number): string {
	return new Date(Date.now() + deltaMs).toISOString();
}

describe('acquireToken', () => {
	it('cached fresh token: returns immediately without refresh or browser dance', async () => {
		fakeAs = await startFakeAs();
		const store = createTokenStore();
		await store.put('my-wiki', {
			access_token: 'cached-fresh-token',
			refresh_token: 'some-refresh',
			expires_at: futureIso(5 * 60 * 1000), // 5 minutes away, well past 60s threshold
			scopes: ['edit'],
			obtained_at: new Date().toISOString(),
		});

		const token = await acquireToken('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
		});

		expect(token).toBe('cached-fresh-token');
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('no stored token: runs browser dance and returns access_token', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const token = await acquireToken('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
			scopes: ['edit'],
		});

		expect(token).toMatch(/^access-CODE-/);
	});

	it('invalid_grant on refresh: falls through to browser dance and returns fresh token', async () => {
		fakeAs = await startFakeAs({
			token: (req, res) => {
				const grant = String(req.body.grant_type ?? '');
				if (grant === 'refresh_token') {
					res.status(400).json({ error: 'invalid_grant' });
					return;
				}
				// authorization_code grant succeeds with a distinct token
				res.json({
					access_token: 'fresh-CODE-' + String(req.body.code),
					refresh_token: 'fresh-refresh',
					expires_in: 3600,
					scope: 'edit',
					token_type: 'Bearer',
				});
			},
		});

		const store = createTokenStore();
		// Token near expiry (30s) — will trigger refresh attempt
		await store.put('my-wiki', {
			access_token: 'stale-access',
			refresh_token: 'stale-refresh',
			expires_at: futureIso(30_000),
			scopes: ['edit'],
			obtained_at: new Date().toISOString(),
		});

		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const token = await acquireToken('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
			scopes: ['edit'],
		});

		expect(token).toMatch(/^fresh-CODE-/);
	});

	it('throws Error when oauth2ClientId is undefined', async () => {
		fakeAs = await startFakeAs();

		await expect(
			acquireToken('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: undefined,
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is null', async () => {
		fakeAs = await startFakeAs();

		await expect(
			acquireToken('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: null,
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is empty string', async () => {
		fakeAs = await startFakeAs();

		await expect(
			acquireToken('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: '',
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is whitespace-only', async () => {
		fakeAs = await startFakeAs();

		await expect(
			acquireToken('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: '   ',
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('non-invalid_grant refresh errors propagate (not swallowed)', async () => {
		fakeAs = await startFakeAs({
			token: (_req, res) => {
				res.status(400).json({ error: 'invalid_client' });
			},
		});

		const store = createTokenStore();
		// Token near expiry — will trigger refresh attempt
		await store.put('my-wiki', {
			access_token: 'stale-access',
			refresh_token: 'stale-refresh',
			expires_at: futureIso(30_000),
			scopes: ['edit'],
			obtained_at: new Date().toISOString(),
		});

		await expect(
			acquireToken('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: 'my-client',
			}),
		).rejects.toMatchObject({ kind: 'invalid_client' });

		// open should NOT have been called — error propagated, no dance
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('concurrent first-callers share one dance (open called once)', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const ctx = {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
			scopes: ['edit'],
		};

		const [t1, t2] = await Promise.all([
			acquireToken('my-wiki', ctx),
			acquireToken('my-wiki', ctx),
		]);

		expect(t1).toBe(t2);
		expect(vi.mocked(openMod).mock.calls.length).toBe(1);
	});
});
