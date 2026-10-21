import type { Config } from '../config/loadConfig.ts';
import { getRuntimeToken } from '../runtime/requestContext.ts';
import { WikiRegistryImpl, type WikiRegistry } from './wikiRegistry.ts';
import { UploadDirsImpl, type UploadDirs } from './uploadDirs.ts';
import { MwnProviderImpl, type MwnProvider } from './mwnProvider.ts';
import { WikiProbeImpl, type WikiProbe } from './wikiProbe.ts';

export interface AppState {
	readonly wikiRegistry: WikiRegistry;
	readonly defaultWikiKey: string;
	readonly uploadDirs: UploadDirs;
	readonly mwnProvider: MwnProvider;
	readonly wikiProbe: WikiProbe;
}

export function createAppState(config: Config): AppState {
	const wikiRegistry = new WikiRegistryImpl(config.wikis, config.allowWikiManagement !== false);
	const uploadDirs = new UploadDirsImpl(config.uploadDirs);
	const mwnProvider = new MwnProviderImpl(wikiRegistry, getRuntimeToken);
	const wikiProbe = new WikiProbeImpl(wikiRegistry, mwnProvider);
	return {
		wikiRegistry,
		defaultWikiKey: config.defaultWiki,
		uploadDirs,
		mwnProvider,
		wikiProbe,
	};
}
