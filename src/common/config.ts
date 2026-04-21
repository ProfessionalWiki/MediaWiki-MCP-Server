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
	 * Username requested from Special:BotPasswords.
	 */
	username?: string | null;
	/**
	 * Password requested from Special:BotPasswords.
	 */
	password?: string | null;
	/**
	 * If the wiki always requires auth to access.
	 * $wgGroupPermissions['*']['read'] = false; in MediaWiki
	 */
	private?: boolean;
	/**
	 * Change tag(s) applied to every write action made through this MCP
	 * server. The tag(s) must be registered and active on the wiki (see
	 * Special:Tags on the target wiki). If the tag is not applicable to
	 * the action, MediaWiki returns a badtags error and the write fails.
	 */
	tags?: string | string[];
}

export type PublicWikiConfig = Omit<WikiConfig, 'token' | 'username' | 'password'>;

export interface Config {
	wikis: { [key: string]: WikiConfig };
	defaultWiki: string;
}

export const defaultConfig: Config = {
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

function replaceEnvVars( value: string ): string {
	return value.replace( /\$\{([^}]+)\}/g, ( match, envVar: string ) => {
		const envValue = process.env[ envVar ];
		return envValue !== undefined ? envValue : match;
	} );
}

function replaceEnvVarsInObject( obj: unknown ): unknown {
	if ( typeof obj === 'string' ) {
		return replaceEnvVars( obj );
	}
	if ( Array.isArray( obj ) ) {
		return obj.map( ( item ) => replaceEnvVarsInObject( item ) );
	}
	if ( obj !== null && typeof obj === 'object' ) {
		const result: Record<string, unknown> = {};
		for ( const [ key, value ] of Object.entries( obj ) ) {
			result[ key ] = replaceEnvVarsInObject( value );
		}
		return result;
	}
	return obj;
}

export function loadConfigFromFile(): Config {
	if ( !fs.existsSync( configPath ) ) {
		return defaultConfig;
	}
	const rawData = fs.readFileSync( configPath, 'utf-8' );
	const parsed = JSON.parse( rawData );
	return replaceEnvVarsInObject( parsed ) as Config;
}
