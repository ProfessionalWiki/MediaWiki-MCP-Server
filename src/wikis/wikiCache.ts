import type { MwnProvider } from './mwnProvider.js';
import type { LicenseCache } from './licenseCache.js';

/**
 * Invalidates wiki-scoped caches. Used by remove-wiki to drop cached wiki
 * state without reaching into individual cache owners.
 */
export interface WikiCache {
	/** Drops every cache entry keyed by `wikiKey`. */
	invalidate( wikiKey: string ): void;
}

export class WikiCacheImpl implements WikiCache {
	public constructor(
		private readonly mwnProvider: Pick<MwnProvider, 'invalidate'>,
		private readonly licenseCache: Pick<LicenseCache, 'delete'>
	) {}

	public invalidate( wikiKey: string ): void {
		this.mwnProvider.invalidate( wikiKey );
		this.licenseCache.delete( wikiKey );
	}
}
