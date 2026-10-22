// tests/auth/stdioSignIn.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioSignIn } from '../../src/auth/stdioSignIn.ts';
import type { RequestHandler } from 'express';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';
import { useTempTokenStore } from '../helpers/tempTokenStore.ts';
import { createTokenStore } from '../../src/auth/tokenStore.ts';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.ts';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.ts';

vi.mock('open', () => ({ default: vi.fn() }));
import openMod from 'open';

useTempTokenStore();
let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
	vi.clearAllMocks();
});

function makeWiki(url: string) {
	return { server: url, scriptpath: '/w' };
}

function futureIso(deltaMs: number): string {
	return new Date(Date.now() + deltaMs).toISOString();
}

const refreshCount = { value: 0 };

afterEach(() => {
	refreshCount.value = 0;
});

// Each refresh grant gets a token numbered by how many the wiki has issued.
function answeringRefreshes(count: { value: number }): RequestHandler {
	return (_req, res) => {
		count.value++;
		res.json({
			access_token: `access-${count.value}`,
			refresh_token: `refresh-${count.value}`,
			expires_in: 3600,
			scope: 'edit',
		});
	};
}

async function storeExpiringToken(): Promise<void> {
	await createTokenStore().put('my-wiki', {
		access_token: 'stale-access',
		refresh_token: 'stale-refresh',
		expires_at: futureIso(30_000),
		scopes: ['edit'],
		obtained_at: new Date().toISOString(),
	});
}

function wikiCtx() {
	return { wiki: makeWiki(fakeAs.url), oauth2ClientId: 'my-client' };
}

describe('StdioSignIn.acquire', () => {
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

		const token = await new StdioSignIn().acquire('my-wiki', {
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

		const token = await new StdioSignIn().acquire('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
			scopes: ['edit'],
		});

		expect(token).toMatch(/^access-CODE-/);
	});

	it('signs in again when the stored token came from another issuer', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);
		await createTokenStore().put('my-wiki', {
			access_token: 'token-from-elsewhere',
			refresh_token: 'refresh-from-elsewhere',
			expires_at: futureIso(5 * 60 * 1000),
			scopes: ['edit'],
			obtained_at: new Date().toISOString(),
			issuer: 'https://elsewhere.example',
		});

		const token = await new StdioSignIn().acquire('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
		});

		expect(token).toMatch(/^access-CODE-/);
	});

	it('records the issuer of a token it signs in for', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		await new StdioSignIn().acquire('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
		});

		const stored = (await createTokenStore().read()).tokens['my-wiki'];
		expect(stored?.issuer).toBe(fakeAs.url);
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

		const token = await new StdioSignIn().acquire('my-wiki', {
			wiki: makeWiki(fakeAs.url),
			oauth2ClientId: 'my-client',
			scopes: ['edit'],
		});

		expect(token).toMatch(/^fresh-CODE-/);
	});

	it('throws Error when oauth2ClientId is undefined', async () => {
		fakeAs = await startFakeAs();

		await expect(
			new StdioSignIn().acquire('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: undefined,
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is null', async () => {
		fakeAs = await startFakeAs();

		await expect(
			new StdioSignIn().acquire('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: null,
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is empty string', async () => {
		fakeAs = await startFakeAs();

		await expect(
			new StdioSignIn().acquire('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: '',
			}),
		).rejects.toThrow("Wiki 'my-wiki' has no oauth2ClientId; cannot acquire OAuth token.");
	});

	it('throws Error when oauth2ClientId is whitespace-only', async () => {
		fakeAs = await startFakeAs();

		await expect(
			new StdioSignIn().acquire('my-wiki', {
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
			new StdioSignIn().acquire('my-wiki', {
				wiki: makeWiki(fakeAs.url),
				oauth2ClientId: 'my-client',
			}),
		).rejects.toMatchObject({ kind: 'invalid_client' });

		// open should NOT have been called — error propagated, no dance
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('concurrent callers to one wiki share one refresh', async () => {
		fakeAs = await startFakeAs({ token: answeringRefreshes(refreshCount) });
		await storeExpiringToken();
		const signIn = new StdioSignIn();

		const tokens = await Promise.all([
			signIn.acquire('my-wiki', wikiCtx()),
			signIn.acquire('my-wiki', wikiCtx()),
			signIn.acquire('my-wiki', wikiCtx()),
		]);

		expect(tokens).toEqual(['access-1', 'access-1', 'access-1']);
		expect(refreshCount.value).toBe(1);
	});

	it('refreshes again once an earlier refresh has finished', async () => {
		fakeAs = await startFakeAs({ token: answeringRefreshes(refreshCount) });
		const signIn = new StdioSignIn();
		await storeExpiringToken();
		await signIn.acquire('my-wiki', wikiCtx());

		await storeExpiringToken();
		const token = await signIn.acquire('my-wiki', wikiCtx());

		expect(token).toBe('access-2');
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

		const signIn = new StdioSignIn();
		const [t1, t2] = await Promise.all([
			signIn.acquire('my-wiki', ctx),
			signIn.acquire('my-wiki', ctx),
		]);

		expect(t1).toBe(t2);
		expect(vi.mocked(openMod).mock.calls.length).toBe(1);
	});
});
