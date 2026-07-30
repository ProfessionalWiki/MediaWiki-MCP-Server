import type { Config } from '../config/loadConfig.ts';
import { getRuntimeToken } from '../runtime/requestContext.ts';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.ts';
import { ActiveWikiImpl, type ActiveWiki } from './activeWiki.ts';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.ts';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.ts';
import { SiteInfoCacheImpl, type SiteInfoCache } from './siteInfoCache.ts';
import { WikiProbeImpl, type WikiProbe } from './wikiProbe.ts';

export interface AppState {
	readonly wikiRegistry: WikiRegistry;
	readonly activeWiki: ActiveWiki;
	readonly uploadDirs: UploadDirs;
	readonly mwnProvider: MwnProvider;
	readonly siteInfoCache: SiteInfoCache;
	readonly wikiProbe: WikiProbe;
}

export function createAppState(config: Config): AppState {
	const wikiRegistry = new WikiRegistryImpl(config.wikis, config.allowWikiManagement !== false);
	const activeWiki = new ActiveWikiImpl(config.defaultWiki, wikiRegistry);
	const uploadDirs = new UploadDirsImpl(config.uploadDirs);
	const mwnProvider = new MwnProviderImpl(wikiRegistry, activeWiki, getRuntimeToken);
	const siteInfoCache = new SiteInfoCacheImpl();
	const wikiProbe = new WikiProbeImpl(wikiRegistry);
	return { wikiRegistry, activeWiki, uploadDirs, mwnProvider, siteInfoCache, wikiProbe };
}
