import { describe, it, expect, vi } from 'vitest';
import { WikiCacheImpl } from '../../src/wikis/wikiCache.ts';

describe('WikiCacheImpl', () => {
	it('invalidates mwnProvider and wikiProbe for the wiki key', () => {
		const mwnProvider = { invalidate: vi.fn() };
		const wikiProbe = { invalidate: vi.fn() };
		const cache = new WikiCacheImpl(mwnProvider, wikiProbe);

		cache.invalidate('en.wikipedia.org');

		expect(mwnProvider.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
		expect(wikiProbe.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
	});
});
