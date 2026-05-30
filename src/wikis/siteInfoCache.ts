export type LicenseInfo = { url: string; title: string };

export type SiteInfo = {
	server: string;
	articlepath: string;
	license?: LicenseInfo;
};

export interface SiteInfoCache {
	get(wikiKey: string): SiteInfo | undefined;
	set(wikiKey: string, value: SiteInfo): void;
	delete(wikiKey: string): void;
}

export class SiteInfoCacheImpl implements SiteInfoCache {
	private readonly cache = new Map<string, SiteInfo>();

	public get(wikiKey: string): SiteInfo | undefined {
		return this.cache.get(wikiKey);
	}

	public set(wikiKey: string, value: SiteInfo): void {
		this.cache.set(wikiKey, value);
	}

	public delete(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}
}
