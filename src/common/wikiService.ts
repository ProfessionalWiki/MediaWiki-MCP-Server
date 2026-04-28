import { wikiRegistry, wikiSelection, uploadDirs } from '../wikis/state.js';
import type { WikiConfig, PublicWikiConfig } from './config.js';

export { DuplicateWikiKeyError } from '../wikis/wikiRegistry.js';

function sanitize( wikiConfig: Readonly<WikiConfig> ): PublicWikiConfig {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { token: _token, username: _username, password: _password, ...publicConfig } = wikiConfig;
	return publicConfig;
}

export const wikiService = {
	getAll: (): Readonly<Record<string, WikiConfig>> => wikiRegistry.getAll(),
	get: ( key: string ): Readonly<WikiConfig> | undefined => wikiRegistry.get( key ),
	add: ( key: string, config: WikiConfig ): void => wikiRegistry.add( key, config ),
	remove: ( key: string ): void => wikiRegistry.remove( key ),
	getCurrent: (): { key: string; config: Readonly<WikiConfig> } => wikiSelection.getCurrent(),
	setCurrent: ( key: string ): void => wikiSelection.setCurrent( key ),
	reset: (): void => wikiSelection.reset(),
	sanitize,
	isWikiManagementAllowed: (): boolean => wikiRegistry.isManagementAllowed(),
	getUploadDirs: (): readonly string[] => uploadDirs.list()
};
