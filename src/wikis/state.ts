import type { Config } from '../config/loadConfig.js';
import { getRuntimeToken } from '../transport/requestContext.js';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.js';
import { ActiveWikiImpl, type ActiveWiki } from './activeWiki.js';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.js';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.js';
import { LicenseCacheImpl, type LicenseCache } from './licenseCache.js';
import { ExtensionDetectorImpl, type ExtensionDetector } from './extensionDetector.js';

export interface AppState {
	readonly wikiRegistry: WikiRegistry;
	readonly activeWiki: ActiveWiki;
	readonly uploadDirs: UploadDirs;
	readonly mwnProvider: MwnProvider;
	readonly licenseCache: LicenseCache;
	readonly extensionDetector: ExtensionDetector;
}

export function createAppState(config: Config): AppState {
	const wikiRegistry = new WikiRegistryImpl(config.wikis, config.allowWikiManagement !== false);
	const activeWiki = new ActiveWikiImpl(config.defaultWiki, wikiRegistry);
	const uploadDirs = new UploadDirsImpl(config.uploadDirs);
	const mwnProvider = new MwnProviderImpl(wikiRegistry, activeWiki, getRuntimeToken);
	const licenseCache = new LicenseCacheImpl();
	const extensionDetector = new ExtensionDetectorImpl(wikiRegistry);
	return { wikiRegistry, activeWiki, uploadDirs, mwnProvider, licenseCache, extensionDetector };
}
