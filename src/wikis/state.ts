import { loadConfigFromFile, type Config } from '../config/loadConfig.js';
import { getRuntimeToken } from '../transport/requestContext.js';
import { WikiRegistryImpl } from './wikiRegistry.js';
import { WikiSelectionImpl } from './wikiSelection.js';
import { UploadDirsImpl } from './uploadDirs.js';
import { MwnProviderImpl } from './mwnProvider.js';
import { LicenseCacheImpl } from './licenseCache.js';

const config: Config = loadConfigFromFile();

export const wikiRegistry = new WikiRegistryImpl(
	config.wikis,
	config.allowWikiManagement !== false,
);

export const wikiSelection = new WikiSelectionImpl(config.defaultWiki, wikiRegistry);

export const uploadDirs = new UploadDirsImpl(config.uploadDirs);

export const mwnProvider = new MwnProviderImpl(wikiRegistry, wikiSelection, getRuntimeToken);

export const licenseCache = new LicenseCacheImpl();
