import type { Config } from '../config/loadConfig.js';
import { getRuntimeToken } from '../transport/requestContext.js';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.js';
import { ActiveWikiImpl, type ActiveWiki } from './activeWiki.js';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.js';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.js';
import { SiteInfoCacheImpl, type SiteInfoCache } from './siteInfoCache.js';
import { WikiProbeImpl, type WikiProbe } from './wikiProbe.js';

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
	// undefined `now` keeps the default Date.now() clock; mwnProvider lets the
	// probe retry authenticated when a wiki denies anonymous siteinfo reads.
	const wikiProbe = new WikiProbeImpl(wikiRegistry, undefined, mwnProvider);
	return { wikiRegistry, activeWiki, uploadDirs, mwnProvider, siteInfoCache, wikiProbe };
}
