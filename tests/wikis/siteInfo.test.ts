import { describe, it, expect, vi } from 'vitest';
import { resolveSiteInfo } from '../../src/wikis/siteInfo.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import type { SiteInfo } from '../../src/wikis/siteInfoCache.js';

// A fresh Map-backed cache (the fakeContext default is seeded; tests of the
// fetch path need an empty cache so resolveSiteInfo actually calls mwn).
function emptyCache() {
	const map = new Map<string, SiteInfo>();
	return {
		get: (k: string) => map.get(k),
		set: (k: string, v: SiteInfo) => {
			map.set(k, v);
		},
		delete: (k: string) => {
			map.delete(k);
		},
	};
}

describe('resolveSiteInfo', () => {
	it('fetches and caches server + articlepath + license from siteinfo', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					general: { server: 'https://public.example', articlepath: '/wiki/$1' },
					rightsinfo: {
						url: 'https://creativecommons.org/licenses/by-sa/4.0/',
						text: 'CC BY-SA 4.0',
					},
				},
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const first = await resolveSiteInfo(ctx, 'test-wiki');
		expect(first).toEqual({
			server: 'https://public.example',
			articlepath: '/wiki',
			license: { url: 'https://creativecommons.org/licenses/by-sa/4.0/', title: 'CC BY-SA 4.0' },
		});

		const second = await resolveSiteInfo(ctx, 'test-wiki');
		expect(second).toEqual(first);
		expect(mock.request).toHaveBeenCalledTimes(1);
	});

	it('normalizes a protocol-relative server to https', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: '//public.example', articlepath: '/wiki/$1' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info.server).toBe('https://public.example');
	});

	it('falls back to config and does not cache when the fetch fails', async () => {
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(new Error('unreachable')) });
		const cache = emptyCache();
		const ctx = fakeContext({ mwn: async () => mock as never, siteInfoCache: cache as never });

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info).toEqual({ server: 'https://test.wiki', articlepath: '/wiki' });
		expect(cache.get('test-wiki')).toBeUndefined();
	});

	it('falls back when the response has no general block', async () => {
		const mock = createMockMwn({ request: vi.fn().mockResolvedValue({ query: {} }) });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info.server).toBe('https://test.wiki');
		expect(info.license).toBeUndefined();
	});

	it('omits license when rightsinfo is absent', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: 'https://public.example', articlepath: '/wiki/$1' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info.license).toBeUndefined();
	});

	it('reduces a root-path articlepath ("/$1") to the empty string', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: 'https://public.example', articlepath: '/$1' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		// A root-path wiki yields '' so buildPageUrl produces `${server}/Title`.
		expect(info.articlepath).toBe('');
	});

	it('coalesces concurrent cold-cache calls into a single siteinfo request', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: 'https://public.example', articlepath: '/wiki/$1' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const [a, b] = await Promise.all([
			resolveSiteInfo(ctx, 'test-wiki'),
			resolveSiteInfo(ctx, 'test-wiki'),
		]);

		expect(a.server).toBe('https://public.example');
		expect(b.server).toBe('https://public.example');
		expect(mock.request).toHaveBeenCalledTimes(1);
	});

	it('falls back when siteinfo returns an empty server', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: '', articlepath: '/wiki/$1' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info.server).toBe('https://test.wiki');
	});

	it('falls back to the configured articlepath when siteinfo omits it', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { general: { server: 'https://public.example' } },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});

		const info = await resolveSiteInfo(ctx, 'test-wiki');
		expect(info.server).toBe('https://public.example');
		expect(info.articlepath).toBe('/wiki');
	});
});
