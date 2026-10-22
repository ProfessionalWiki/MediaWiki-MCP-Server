import { Mwn } from 'mwn';
import type { Config } from '../config/loadConfig.ts';
import { makeApiRequest } from '../outbound/httpFetch.ts';
import { getRuntimeToken } from '../runtime/requestContext.ts';
import { runExecSecret } from './execSecret.ts';
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
	const mwnProvider = new MwnProviderImpl(
		wikiRegistry,
		getRuntimeToken,
		(options) => new Mwn(options),
		runExecSecret,
	);
	const wikiProbe = new WikiProbeImpl(wikiRegistry, mwnProvider, makeApiRequest);
	return {
		wikiRegistry,
		defaultWikiKey: config.defaultWiki,
		uploadDirs,
		mwnProvider,
		wikiProbe,
	};
}
