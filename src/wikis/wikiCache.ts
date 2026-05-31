import type { MwnProvider } from './mwnProvider.js';
import type { SiteInfoCache } from './siteInfoCache.js';
import type { WikiProbe } from './wikiProbe.js';

/**
 * Invalidates wiki-scoped caches. Used by remove-wiki to drop cached wiki
 * state without reaching into individual cache owners.
 */
export interface WikiCache {
	/** Drops every cache entry keyed by `wikiKey`. */
	invalidate(wikiKey: string): void;
}

export class WikiCacheImpl implements WikiCache {
	public constructor(
		private readonly mwnProvider: Pick<MwnProvider, 'invalidate'>,
		private readonly siteInfoCache: Pick<SiteInfoCache, 'delete'>,
		private readonly wikiProbe: Pick<WikiProbe, 'invalidate'>,
	) {}

	public invalidate(wikiKey: string): void {
		this.mwnProvider.invalidate(wikiKey);
		this.siteInfoCache.delete(wikiKey);
		this.wikiProbe.invalidate(wikiKey);
	}
}
