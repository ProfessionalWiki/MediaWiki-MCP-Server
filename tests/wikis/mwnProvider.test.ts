import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConstructor, mockGetSiteInfo, mockInit } = vi.hoisted(() => ({
	mockConstructor: vi.fn(),
	mockGetSiteInfo: vi.fn(),
	mockInit: vi.fn(),
}));

vi.mock('mwn', () => ({
	Mwn: class MockMwn {
		public constructor(options: unknown) {
			mockConstructor(options);
		}
		public getSiteInfo = mockGetSiteInfo;
		public static init = mockInit;
	},
}));

vi.mock('../../src/runtime/constants.js', () => ({
	USER_AGENT: 'test-agent',
}));

import { MwnProviderImpl } from '../../src/wikis/mwnProvider.js';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.js';
import { WikiSelectionImpl } from '../../src/wikis/wikiSelection.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}.example.com`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

describe('MwnProviderImpl', () => {
	beforeEach(() => {
		mockConstructor.mockReset();
		mockGetSiteInfo.mockReset();
		mockInit.mockReset();
		mockGetSiteInfo.mockResolvedValue(undefined);
	});

	it('caches non-runtime-token mwn instances per key', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new WikiSelectionImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		const m1 = await provider.get();
		const m2 = await provider.get();
		expect(m1).toBe(m2);
		expect(mockConstructor).toHaveBeenCalledOnce();
	});

	it('returns different instances for different keys', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new WikiSelectionImpl('a', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		const m1 = await provider.get('a');
		const m2 = await provider.get('b');
		expect(m1).not.toBe(m2);
	});

	it('creates fresh mwn per call when runtime token is set', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new WikiSelectionImpl('a', reg);
		mockInit.mockImplementation(async (options: unknown) => ({ id: 'oauth', options }));
		const provider = new MwnProviderImpl(reg, sel, () => 'TOKEN');
		const m1 = await provider.get();
		const m2 = await provider.get();
		expect(m1).not.toBe(m2);
		expect(mockInit).toHaveBeenCalledTimes(2);
	});

	it('invalidate clears the cache for one key', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new WikiSelectionImpl('a', reg);
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
		const sel = new WikiSelectionImpl('gone', reg);
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await expect(provider.get('missing')).rejects.toThrow(/not found/);
	});

	it('evicts a failed cache entry so the next call retries', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new WikiSelectionImpl('a', reg);
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

	it('uses Mwn.init with OAuth2 token when config has token', async () => {
		const reg = new WikiRegistryImpl(
			{
				a: { ...sample('a'), token: 'config-token' },
			},
			true,
		);
		const sel = new WikiSelectionImpl('a', reg);
		mockInit.mockResolvedValue({ id: 'oauth' });
		const provider = new MwnProviderImpl(reg, sel, () => undefined);
		await provider.get();
		expect(mockInit).toHaveBeenCalledWith(
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
		const sel = new WikiSelectionImpl('a', reg);
		mockInit.mockResolvedValue({ id: 'oauth' });
		const provider = new MwnProviderImpl(reg, sel, () => 'runtime-token');
		await provider.get();
		expect(mockInit).toHaveBeenCalledWith(
			expect.objectContaining({
				OAuth2AccessToken: 'runtime-token',
			}),
		);
	});
});
