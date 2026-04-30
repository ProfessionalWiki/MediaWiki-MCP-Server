import { describe, it, expect, vi } from 'vitest';
import { WikiCacheImpl } from '../../src/wikis/wikiCache.js';

describe('WikiCacheImpl', () => {
	it('invalidates mwnProvider, licenseCache, and extensionDetector for the wiki key', () => {
		const mwnProvider = { invalidate: vi.fn() };
		const licenseCache = { delete: vi.fn() };
		const extensionDetector = { invalidate: vi.fn() };
		const cache = new WikiCacheImpl(mwnProvider, licenseCache, extensionDetector);

		cache.invalidate('en.wikipedia.org');

		expect(mwnProvider.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
		expect(licenseCache.delete).toHaveBeenCalledWith('en.wikipedia.org');
		expect(extensionDetector.invalidate).toHaveBeenCalledWith('en.wikipedia.org');
	});
});
