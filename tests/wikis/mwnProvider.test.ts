import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
	mockConstructor,
	mockGetSiteInfo,
	mockInitOAuth,
	mockLogin,
	mockGetTokensAndSiteInfo,
	mockRawRequest,
} = vi.hoisted(() => ({
	mockConstructor: vi.fn(),
	mockGetSiteInfo: vi.fn(),
	mockInitOAuth: vi.fn(),
	mockLogin: vi.fn(),
	mockGetTokensAndSiteInfo: vi.fn(),
	mockRawRequest: vi.fn(),
}));

vi.mock('mwn', () => ({
	Mwn: class MockMwn {
		public constructor(options: unknown) {
			mockConstructor(options);
		}
		public getSiteInfo = mockGetSiteInfo;
		public initOAuth = mockInitOAuth;
		public login = mockLogin;
		public getTokensAndSiteInfo = mockGetTokensAndSiteInfo;
		public rawRequest = mockRawRequest;
	},
}));

vi.mock('../../src/runtime/constants.ts', () => ({
	USER_AGENT: 'test-agent',
}));

const { mockRunExecSecret } = vi.hoisted(() => ({ mockRunExecSecret: vi.fn() }));
vi.mock('../../src/wikis/execSecret.ts', () => ({
	runExecSecret: mockRunExecSecret,
}));

import { MwnProviderImpl } from '../../src/wikis/mwnProvider.ts';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.ts';
import { ActiveWikiImpl } from '../../src/wikis/activeWiki.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { CredentialResolutionError } from '../../src/errors/credentialResolutionError.ts';
import { withRequestFields } from '../../src/runtime/requestContext.ts';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}.example.com`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

describe('MwnProviderImpl', () => {
	// The bounded view intercepts `rawRequest`, so the doubles must route through
	// it for a test to observe whether the sign-in was bounded.
	async function signIn(this: { rawRequest: (options: unknown) => Promise<unknown> }) {
		await this.rawRequest({ url: 'https://a.example.com/w/api.php' });
	}

	beforeEach(() => {
		mockConstructor.mockReset();
		mockRawRequest.mockReset().mockResolvedValue({});
		mockInitOAuth.mockReset();
		mockGetSiteInfo.mockReset().mockImplementation(signIn);
		mockLogin.mockReset().mockImplementation(signIn);
		mockGetTokensAndSiteInfo.mockReset().mockImplementation(signIn);
		mockRunExecSecret.mockReset();
	});

	it('caches non-runtime-token mwn instances per key', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		const m1 = await provider.get();
		const m2 = await provider.get();
		expect(m1).toBe(m2);
		expect(mockConstructor).toHaveBeenCalledOnce();
	});

	it('returns different instances for different keys', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		const m1 = await provider.get('a');
		const m2 = await provider.get('b');
		expect(m1).not.toBe(m2);
	});

	it('creates fresh mwn per call when runtime token is set', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => 'TOKEN');
		const m1 = await provider.get();
		const m2 = await provider.get();
		expect(m1).not.toBe(m2);
		expect(mockConstructor).toHaveBeenCalledTimes(2);
	});

	it('invalidate clears the cache for one key', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		const m1a = await provider.get('a');
		const m1b = await provider.get('b');
		provider.invalidate('a');
		const m2a = await provider.get('a');
		const m2b = await provider.get('b');
		expect(m2a).not.toBe(m1a);
		expect(m2b).toBe(m1b);
	});

	it('throws when wiki key is unknown', async () => {
		const reg = new WikiRegistryImpl({}, true);
		const sel = new ActiveWikiImpl('gone', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await expect(provider.get('missing')).rejects.toThrow(/not found/);
	});

	it('evicts a failed cache entry so the next call retries', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		mockGetSiteInfo
			.mockReset()
			.mockRejectedValueOnce(new Error('transient'))
			.mockResolvedValueOnce(undefined);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await expect(provider.get()).rejects.toThrow(/transient/);
		const retry = await provider.get();
		expect(retry).toBeDefined();
		expect(mockConstructor).toHaveBeenCalledTimes(2);
	});

	it('passes the OAuth2 token from config to mwn', async () => {
		const reg = new WikiRegistryImpl(
			{
				a: { ...sample('a'), token: 'config-token' },
			},
			true,
		);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await provider.get();
		expect(mockConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				OAuth2AccessToken: 'config-token',
			}),
		);
	});

	it('runtime token wins over config token', async () => {
		const reg = new WikiRegistryImpl(
			{
				a: { ...sample('a'), token: 'config-token' },
			},
			true,
		);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => 'runtime-token');
		await provider.get();
		expect(mockConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				OAuth2AccessToken: 'runtime-token',
			}),
		);
	});

	it('sets assert=user for BotPassword auth so mwn relogs in on session loss', async () => {
		const reg = new WikiRegistryImpl(
			{
				a: { ...sample('a'), username: 'Bot@MCP', password: 'secret' },
			},
			true,
		);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await provider.get();
		expect(mockConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				username: 'Bot@MCP',
				password: 'secret',
				defaultParams: expect.objectContaining({ assert: 'user' }),
			}),
		);
	});

	it('does not set assert=user for OAuth2 token auth', async () => {
		const reg = new WikiRegistryImpl(
			{
				a: { ...sample('a'), token: 'config-token' },
			},
			true,
		);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await provider.get();
		const options = mockConstructor.mock.calls[0]?.[0] as { defaultParams?: { assert?: unknown } };
		expect(options.defaultParams?.assert).toBeUndefined();
	});

	it('does not set assert=user for anonymous mode', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await provider.get();
		const options = mockConstructor.mock.calls[0]?.[0] as { defaultParams?: { assert?: unknown } };
		expect(options.defaultParams?.assert).toBeUndefined();
	});

	// The provider drives sign-in itself, so the branch mwn used to pick is ours.
	it('signs in with the OAuth 2 handshake when a token is configured', async () => {
		const reg = new WikiRegistryImpl({ a: { ...sample('a'), token: 'config-token' } }, true);
		const provider = new MwnProviderImpl(reg, new ActiveWikiImpl('a', reg), () => undefined);

		await provider.get();

		expect(mockInitOAuth).toHaveBeenCalledOnce();
		expect(mockGetTokensAndSiteInfo).toHaveBeenCalledOnce();
		expect(mockLogin).not.toHaveBeenCalled();
		// initOAuth() sets the flag that makes mwn attach the bearer, so a
		// handshake issued before it would go out unauthenticated.
		expect(mockInitOAuth.mock.invocationCallOrder[0]).toBeLessThan(
			mockGetTokensAndSiteInfo.mock.invocationCallOrder[0]!,
		);
	});

	it('logs in when a bot password is configured', async () => {
		const reg = new WikiRegistryImpl(
			{ a: { ...sample('a'), username: 'Bot@MCP', password: 'secret' } },
			true,
		);
		const provider = new MwnProviderImpl(reg, new ActiveWikiImpl('a', reg), () => undefined);

		await provider.get();

		expect(mockLogin).toHaveBeenCalledOnce();
		expect(mockInitOAuth).not.toHaveBeenCalled();
		expect(mockGetTokensAndSiteInfo).not.toHaveBeenCalled();
	});

	it('only reads site info when the wiki has no credentials', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const provider = new MwnProviderImpl(reg, new ActiveWikiImpl('a', reg), () => undefined);

		await provider.get();

		expect(mockGetSiteInfo).toHaveBeenCalledOnce();
		expect(mockLogin).not.toHaveBeenCalled();
		expect(mockInitOAuth).not.toHaveBeenCalled();
	});

	it('bounds the sign-in that reaching a wiki for the first time performs', async () => {
		const reg = new WikiRegistryImpl(
			{ a: { ...sample('a'), username: 'Bot@MCP', password: 'secret' } },
			true,
		);
		const provider = new MwnProviderImpl(reg, new ActiveWikiImpl('a', reg), () => undefined);

		await provider.get();

		// Three round-trips that each fund a fresh retry ladder, which `Mwn.init`
		// left carrying no signal at all.
		expect(mockRawRequest.mock.calls[0]?.[0]?.signal).toBeDefined();
	});

	it('keeps a shared sign-in alive when the caller that triggered it cancels', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const provider = new MwnProviderImpl(reg, new ActiveWikiImpl('a', reg), () => undefined);
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, () => provider.get());
		controller.abort();

		// Cached and handed to every concurrent caller, so tying it to the first
		// arrival's cancellation would fail the rest.
		expect(mockRawRequest.mock.calls[0]?.[0]?.signal.aborted).toBe(false);
	});

	describe('lazy exec-backed credentials', () => {
		const execWiki = (name: string): WikiConfig => ({
			...sample(name),
			token: { exec: { command: 'op', args: ['read', 'x'] } },
		});

		it('runs the exec command once on first use and reuses the cached value', async () => {
			mockRunExecSecret.mockResolvedValue('exec-token');
			const reg = new WikiRegistryImpl({ a: execWiki('a') }, true);
			const sel = new ActiveWikiImpl('a', reg);
			const provider = new MwnProviderImpl(reg, sel, () => undefined);

			await provider.get('a');
			await provider.get('a');

			expect(mockRunExecSecret).toHaveBeenCalledOnce();
			expect(mockConstructor).toHaveBeenCalledWith(
				expect.objectContaining({ OAuth2AccessToken: 'exec-token' }),
			);
		});

		it('never runs the exec command for a wiki that is not used', async () => {
			mockRunExecSecret.mockResolvedValue('exec-token');
			const reg = new WikiRegistryImpl({ a: sample('a'), b: execWiki('b') }, true);
			const sel = new ActiveWikiImpl('a', reg);
			const provider = new MwnProviderImpl(reg, sel, () => undefined);

			await provider.get('a');

			expect(mockRunExecSecret).not.toHaveBeenCalled();
		});

		it('surfaces a failing exec command as a CredentialResolutionError', async () => {
			mockRunExecSecret.mockRejectedValue(
				new CredentialResolutionError('Could not resolve the "token" credential for wiki "a"'),
			);
			const reg = new WikiRegistryImpl({ a: execWiki('a') }, true);
			const sel = new ActiveWikiImpl('a', reg);
			const provider = new MwnProviderImpl(reg, sel, () => undefined);

			await expect(provider.get('a')).rejects.toBeInstanceOf(CredentialResolutionError);
		});

		it('does not resolve config secrets when a runtime token is present', async () => {
			const reg = new WikiRegistryImpl({ a: execWiki('a') }, true);
			const sel = new ActiveWikiImpl('a', reg);
			const provider = new MwnProviderImpl(reg, sel, () => 'runtime-token');

			await provider.get('a');

			expect(mockRunExecSecret).not.toHaveBeenCalled();
		});

		it('retries a failing exec command on the next call', async () => {
			mockRunExecSecret
				.mockRejectedValueOnce(new CredentialResolutionError('transient'))
				.mockResolvedValueOnce('exec-token');
			const reg = new WikiRegistryImpl({ a: execWiki('a') }, true);
			const sel = new ActiveWikiImpl('a', reg);
			const provider = new MwnProviderImpl(reg, sel, () => undefined);

			await expect(provider.get('a')).rejects.toBeInstanceOf(CredentialResolutionError);
			await provider.get('a');
			expect(mockRunExecSecret).toHaveBeenCalledTimes(2);
		});
	});
});
