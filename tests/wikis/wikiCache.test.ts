import { describe, it, expect, vi } from 'vitest';
import { WikiCacheImpl } from '../../src/wikis/wikiCache.js';

describe('WikiCacheImpl', () => {
	it('invalidates mwnProvider, siteInfoCache, and wikiProbe for the wiki key', () => {
		const mwnProvider = { invalidate: vi.fn() };
		const siteInfoCache = { delete: vi.fn() };
		const wikiProbe = { invalidate: vi.fn() };
		const cache = new WikiCacheImpl(mwnProvider, siteInfoCache, wikiProbe);

		cache.invalidate('en.wikipedia.org');

		expect(mwnProvider.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
		expect(siteInfoCache.delete).toHaveBeenCalledWith('en.wikipedia.org');
		expect(wikiProbe.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
	});
});
