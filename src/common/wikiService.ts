import {
	WikiConfig,
	PublicWikiConfig,
	loadConfigFromFile
} from './config.js';

type DeepReadonly<T> = {
	readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

const config = loadConfigFromFile();

let currentWikiKey: string = config.defaultWiki;

function sanitize( wikiConfig: DeepReadonly<WikiConfig> ): PublicWikiConfig {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { token: _token, username: _username, password: _password, ...publicConfig } = wikiConfig;
	return publicConfig;
}

function getAll(): DeepReadonly<Record<string, WikiConfig>> {
	return config.wikis as DeepReadonly<Record<string, WikiConfig>>;
}

function get( key: string ): DeepReadonly<WikiConfig> | undefined {
	return config.wikis[ key ] as DeepReadonly<WikiConfig> | undefined;
}

function add( key: string, wikiConfig: WikiConfig ): void {
	if ( !key || key.trim() === '' ) {
		throw new Error( 'Wiki key cannot be empty' );
	}

	if ( config.wikis[ key ] ) {
		throw new Error( `Wiki "${ key }" already exists in configuration` );
	}

	config.wikis[ key ] = wikiConfig;
}

function remove( key: string ): void {
	delete config.wikis[ key ];
}

function getCurrent(): { key: string; config: DeepReadonly<WikiConfig> } {
	return {
		key: currentWikiKey,
		config: config.wikis[ currentWikiKey ] as DeepReadonly<WikiConfig>
	};
}

function setCurrent( key: string ): void {
	if ( !config.wikis[ key ] ) {
		throw new Error( `Wiki "${ key }" not found in config.json` );
	}
	currentWikiKey = key;
}

function reset(): void {
	if ( config.wikis[ config.defaultWiki ] ) {
		currentWikiKey = config.defaultWiki;
	} else {
		throw new Error( `Default wiki "${ config.defaultWiki }" not found in config.json` );
	}
}

export const wikiService = {
	getAll,
	get,
	add,
	remove,
	getCurrent,
	setCurrent,
	sanitize,
	reset
};
