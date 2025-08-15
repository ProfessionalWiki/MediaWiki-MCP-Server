// TODO: Investigate if we can define config as a MCP resource
import * as fs from 'fs';

export interface WikiConfig {
	/**
	 * Corresponds to the $wgSitename setting in MediaWiki.
	 */
	sitename: string;
	/**
	 * Corresponds to the $wgServer setting in MediaWiki.
	 */
	server: string;
	/**
	 * Corresponds to the $wgArticlePath setting in MediaWiki.
	 */
	articlepath: string;
	/**
	 * Corresponds to the $wgScriptPath setting in MediaWiki.
	 */
	scriptpath: string;
	/**
	 * OAuth consumer token requested from Extension:OAuth.
	 */
	token?: string | null;
	/**
	 * If the wiki always requires auth to access.
	 * $wgGroupPermissions['*']['read'] = false; in MediaWiki
	 */
	private?: boolean;
}

interface Config {
	wikis: { [key: string]: WikiConfig };
	defaultWiki: string;
}

const defaultConfig: Config = {
	defaultWiki: 'en.wikipedia.org',
	wikis: {
		'en.wikipedia.org': {
			sitename: 'Wikipedia',
			server: 'https://en.wikipedia.org',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: null,
			private: false
		},
		'localhost:8080': {
			sitename: 'Local MediaWiki Docker',
			server: 'http://localhost:8080',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: null,
			private: false
		}
	}
};

const configPath = process.env.CONFIG || 'config.json';

function loadConfigFromFile(): Config {
	if ( !fs.existsSync( configPath ) ) {
		return defaultConfig;
	}
	const rawData = fs.readFileSync( configPath, 'utf-8' );
	return JSON.parse( rawData ) as Config;
}

const config = loadConfigFromFile();
const defaultWiki = config.defaultWiki;
let currentConfig: WikiConfig = config.wikis[ defaultWiki ];

if ( !currentConfig ) {
	throw new Error( `Default wiki "${ defaultWiki }" not found in config.json` );
}

export function getAllWikis(): Readonly<{ [key: string]: WikiConfig }> {
	return config.wikis;
}

export function getCurrentWikiConfig(): Readonly<WikiConfig> {
	return currentConfig;
}

export function setCurrentWiki( wiki: string ): void {
	if ( !config.wikis[ wiki ] ) {
		throw new Error( `Wiki "${ wiki }" not found in config.json` );
	}
	currentConfig = config.wikis[ wiki ];
}

export function updateWikiConfig( wiki: string, newConfig: WikiConfig ): void {
	config.wikis[ wiki ] = { ...newConfig };
	// Do not write to config file for now
	// @see https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/pull/22#issuecomment-2920361315
	// fs.writeFileSync( configPath, JSON.stringify( config, null, 2 ), 'utf-8' );
}

export function resetConfig(): void {
	if ( config.wikis[ defaultWiki ] ) {
		currentConfig = config.wikis[ defaultWiki ];
	} else {
		throw new Error( `Default wiki "${ defaultWiki }" not found in config.json` );
	}
}

export const wikiServer = (): string => getCurrentWikiConfig().server;
export const articlePath = (): string => getCurrentWikiConfig().articlepath;
export const scriptPath = (): string => getCurrentWikiConfig().scriptpath;
export const oauthToken = (): string | null | undefined => {
	const token = getCurrentWikiConfig().token;
	return isTokenValid( token ) ? token : undefined;
};
export const privateWiki = (): boolean | undefined => getCurrentWikiConfig().private;
export const siteName = (): string | undefined => getCurrentWikiConfig().sitename;

function isTokenValid( token: string | null | undefined ): boolean {
	return token !== undefined && token !== null && token !== '';
}
