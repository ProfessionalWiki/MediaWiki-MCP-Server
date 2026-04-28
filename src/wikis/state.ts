import { loadConfigFromFile, type Config } from '../common/config.js';
import { getRuntimeToken } from '../common/requestContext.js';
import { WikiRegistryImpl } from './wikiRegistry.js';
import { WikiSelectionImpl } from './wikiSelection.js';
import { UploadDirsImpl } from './uploadDirs.js';
import { MwnProviderImpl } from './mwnProvider.js';

const config: Config = loadConfigFromFile();

export const wikiRegistry = new WikiRegistryImpl(
	config.wikis,
	config.allowWikiManagement !== false
);

export const wikiSelection = new WikiSelectionImpl(
	config.defaultWiki,
	wikiRegistry
);

export const uploadDirs = new UploadDirsImpl( config.uploadDirs );

export const mwnProvider = new MwnProviderImpl(
	wikiRegistry,
	wikiSelection,
	getRuntimeToken
);
