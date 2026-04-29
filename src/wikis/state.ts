import type { Config } from '../config/loadConfig.js';
import { getRuntimeToken } from '../transport/requestContext.js';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.js';
import { WikiSelectionImpl, type WikiSelection } from './wikiSelection.js';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.js';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.js';
import { LicenseCacheImpl, type LicenseCache } from './licenseCache.js';

export interface AppState {
	readonly wikiRegistry: WikiRegistry;
	readonly wikiSelection: WikiSelection;
	readonly uploadDirs: UploadDirs;
	readonly mwnProvider: MwnProvider;
	readonly licenseCache: LicenseCache;
}

export function createAppState(config: Config): AppState {
	const wikiRegistry = new WikiRegistryImpl(
		config.wikis,
		config.allowWikiManagement !== false,
	);
	const wikiSelection = new WikiSelectionImpl(config.defaultWiki, wikiRegistry);
	const uploadDirs = new UploadDirsImpl(config.uploadDirs);
	const mwnProvider = new MwnProviderImpl(wikiRegistry, wikiSelection, getRuntimeToken);
	const licenseCache = new LicenseCacheImpl();
	return { wikiRegistry, wikiSelection, uploadDirs, mwnProvider, licenseCache };
}
