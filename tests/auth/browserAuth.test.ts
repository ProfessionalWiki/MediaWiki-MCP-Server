// tests/auth/browserAuth.test.ts
import { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserAuth, BrowserAuthError } from '../../src/auth/browserAuth.ts';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';
import { useTempTokenStore } from '../helpers/tempTokenStore.ts';
import { createTokenStore } from '../../src/auth/tokenStore.ts';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.ts';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.ts';

vi.mock('open', () => ({ default: vi.fn() }));
import openMod from 'open';

useTempTokenStore();

let fakeAs: FakeAsHandle;

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
	vi.unstubAllEnvs();
});

function makeWiki(url: string) {
	return { server: url, scriptpath: '/w' };
}

describe('browserAuth', () => {
	it('happy path: returns access_token and persists token to store', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const token = await browserAuth('test-wiki', {
			wiki: makeWiki(fakeAs.url),
			clientId: 'my-client',
			scopes: ['edit'],
		});

		expect(token).toMatch(/^access-CODE-/);

		const store = createTokenStore();
		const creds = await store.read();
		const stored = creds.tokens['test-wiki'];
		expect(stored).toBeDefined();
		expect(stored?.access_token).toBe(token);
		expect(stored?.scopes).toContain('edit');
		expect(stored?.expires_at).toBeDefined();
		expect(stored?.obtained_at).toBeDefined();
	});

	it('user_denied: rejects with BrowserAuthError reason=user_denied', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(fakeBrowserDriver(fakeAs.url, 'deny') as typeof openMod);

		await expect(
			browserAuth('test-wiki', {
				wiki: makeWiki(fakeAs.url),
				clientId: 'my-client',
				scopes: ['edit'],
			}),
		).rejects.toMatchObject({ reason: 'user_denied' });
	});

	it('state_mismatch: rejects with reason=state_mismatch when callback state is tampered', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'tampered_state') as typeof openMod,
		);

		await expect(
			browserAuth('test-wiki', {
				wiki: makeWiki(fakeAs.url),
				clientId: 'my-client',
				scopes: ['edit'],
			}),
		).rejects.toMatchObject({ reason: 'state_mismatch' });
	});

	it('timeout: rejects with BrowserAuthError reason=timeout when no callback arrives', async () => {
		fakeAs = await startFakeAs();
		// open mock does nothing — no callback will arrive. `open` resolves with the
		// browser's ChildProcess, which browserAuth discards, so an unspawned one
		// stands in for it.
		vi.mocked(openMod).mockResolvedValue(new ChildProcess());

		await expect(
			browserAuth('test-wiki', {
				wiki: makeWiki(fakeAs.url),
				clientId: 'my-client',
				timeoutMs: 200,
			}),
		).rejects.toMatchObject({ reason: 'timeout' });
	});

	it('callbackPort: rejects with listen_failed when the configured port is in use', async () => {
		fakeAs = await startFakeAs();
		// Holding the port forces EADDRINUSE.
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
		const fixedPort = (blocker.address() as AddressInfo).port;
		try {
			await expect(
				browserAuth('test-wiki', {
					wiki: makeWiki(fakeAs.url),
					clientId: 'my-client',
					callbackPort: fixedPort,
				}),
			).rejects.toMatchObject({
				reason: 'listen_failed',
				message: expect.stringContaining(`Port ${fixedPort}`) as unknown as string,
			});
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it('callbackPort: binds the requested port and uses it in redirect_uri', async () => {
		fakeAs = await startFakeAs();
		const fixedPort = await freePort();
		// Capture the URL passed to open() so we can assert the redirect_uri.
		let capturedAuthUrl = '';
		vi.mocked(openMod).mockImplementation((async (url: string) => {
			capturedAuthUrl = url;
			// Drive the dance to completion so the test doesn't time out.
			await fakeBrowserDriver(fakeAs!.url, 'consent')(url);
		}) as unknown as typeof openMod);

		const tok = await browserAuth('test-wiki', {
			wiki: makeWiki(fakeAs.url),
			clientId: 'my-client',
			scopes: ['edit'],
			callbackPort: fixedPort,
		});

		expect(tok).toMatch(/^access-CODE/);
		const redirect = new URL(capturedAuthUrl).searchParams.get('redirect_uri');
		expect(redirect).toBe(`http://127.0.0.1:${fixedPort}/oauth/callback`);
	});

	it('MCP_OAUTH_NO_BROWSER=1: skips open(), listener still runs but times out', async () => {
		fakeAs = await startFakeAs();
		vi.stubEnv('MCP_OAUTH_NO_BROWSER', '1');
		// Silence the URL log to keep the vitest reporter clean. Assert it was
		// emitted at least once so the headless-fallback path is still observed.
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		await expect(
			browserAuth('test-wiki', {
				wiki: makeWiki(fakeAs.url),
				clientId: 'my-client',
				timeoutMs: 200,
			}),
		).rejects.toMatchObject({ reason: 'timeout' });

		expect(vi.mocked(openMod).mock.calls.length).toBe(0);
		const wrote = stderrSpy.mock.calls.some(
			(args) => typeof args[0] === 'string' && args[0].includes('Open this URL to log in'),
		);
		expect(wrote).toBe(true);
		stderrSpy.mockRestore();
	});

	it('BrowserAuthError is an instanceof Error', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(fakeBrowserDriver(fakeAs.url, 'deny') as typeof openMod);

		let caught: unknown;
		try {
			await browserAuth('test-wiki', {
				wiki: makeWiki(fakeAs.url),
				clientId: 'my-client',
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(BrowserAuthError);
		expect(caught).toBeInstanceOf(Error);
	});
});

/** A port the OS just handed out and took back, so no other test holds it. */
async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}
