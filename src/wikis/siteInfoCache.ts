import { monotonicNow } from '../runtime/clock.ts';

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 hour
const TTL_FAILURE_MS = 60 * 1000; // 60 seconds

export type LicenseInfo = { url: string; title: string };

export type SiteInfo = {
	server: string;
	articlepath: string;
	/** The wiki's content language ($wgLanguageCode); absent when siteinfo omitted it. */
	lang?: string;
	license?: LicenseInfo;
	/**
	 * Namespace IDs the wiki counts as content ($wgContentNamespaces), ascending;
	 * absent when siteinfo did not report a namespace map.
	 */
	contentNamespaces?: readonly number[];
	/**
	 * SPARQL endpoint of the query service backing this wiki's Wikibase
	 * repository, as published in siteinfo; absent on a wiki that publishes none.
	 */
	sparqlEndpoint?: string;
};

export interface SiteInfoCache {
	/** The wiki's siteinfo as last stored, however old. */
	get(wikiKey: string): SiteInfo | undefined;
	/** False once the stored siteinfo is due for a refetch, or when none is stored. */
	isFresh(wikiKey: string): boolean;
	set(wikiKey: string, value: SiteInfo): void;
	/** Puts off the next refetch of the stored siteinfo by a minute, after one has failed. */
	deferRefetch(wikiKey: string): void;
	delete(wikiKey: string): void;
}

// Entries go stale after an hour, so that a wiki's changed settings, such as a
// namespace newly counted as content, are picked up without a restart.
export class SiteInfoCacheImpl implements SiteInfoCache {
	private readonly cache = new Map<string, { value: SiteInfo; expiresAt: number }>();

	public constructor(private readonly now: () => number = monotonicNow) {}

	public get(wikiKey: string): SiteInfo | undefined {
		return this.cache.get(wikiKey)?.value;
	}

	public isFresh(wikiKey: string): boolean {
		const entry = this.cache.get(wikiKey);
		return entry !== undefined && entry.expiresAt > this.now();
	}

	public set(wikiKey: string, value: SiteInfo): void {
		this.cache.set(wikiKey, { value, expiresAt: this.now() + TTL_SUCCESS_MS });
	}

	public deferRefetch(wikiKey: string): void {
		const entry = this.cache.get(wikiKey);
		if (entry) {
			this.cache.set(wikiKey, { value: entry.value, expiresAt: this.now() + TTL_FAILURE_MS });
		}
	}

	public delete(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}
}
