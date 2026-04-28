export type LicenseInfo = { url: string; title: string };

export interface LicenseCache {
	get(wikiKey: string): LicenseInfo | undefined;
	set(wikiKey: string, value: LicenseInfo): void;
	delete(wikiKey: string): void;
}

export class LicenseCacheImpl implements LicenseCache {
	private readonly cache = new Map<string, LicenseInfo>();

	public get(wikiKey: string): LicenseInfo | undefined {
		return this.cache.get(wikiKey);
	}

	public set(wikiKey: string, value: LicenseInfo): void {
		this.cache.set(wikiKey, value);
	}

	public delete(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}
}
