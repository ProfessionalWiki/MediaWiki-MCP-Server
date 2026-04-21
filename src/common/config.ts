import * as fs from 'fs';
import { execFileSync } from 'child_process';

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
	tags?: string | string[] | null;
}

export type PublicWikiConfig = Omit<WikiConfig, 'token' | 'username' | 'password'>;

export interface Config {
	wikis: { [key: string]: WikiConfig };
	defaultWiki: string;
	/**
	 * When false, the `add-wiki` and `remove-wiki` tools are disabled, freezing
	 * the configured wiki set at startup. Defaults to true.
	 */
	allowWikiManagement?: boolean;
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

const SECRET_FIELDS = [ 'token', 'username', 'password' ] as const;
type SecretFieldName = typeof SECRET_FIELDS[ number ];

function isSecretField( name: string ): name is SecretFieldName {
	return ( SECRET_FIELDS as readonly string[] ).includes( name );
}

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

function resolveSecretField(
	raw: unknown,
	wikiKey: string,
	fieldName: SecretFieldName
): string | null | undefined {
	if ( raw === null || raw === undefined ) {
		return raw;
	}
	if ( typeof raw === 'string' ) {
		if ( raw.includes( '${' ) ) {
			const substituted = replaceEnvVars( raw );
			const unresolved = substituted.match( /\$\{([^}]+)\}/ );
			if ( unresolved ) {
				throw new Error(
					`Config error: environment variable "${ unresolved[ 1 ] }" referenced by wikis.${ wikiKey }.${ fieldName } is not set`
				);
			}
			return substituted;
		}
		if ( raw !== '' ) {
			process.stderr.write(
				`warning: wikis.${ wikiKey }.${ fieldName } contains a plaintext credential. Prefer \${VAR} or an {exec: …} object. See README.\n`
			);
		}
		return raw;
	}
	if ( typeof raw === 'object' && !Array.isArray( raw ) ) {
		return runExec( raw, wikiKey, fieldName );
	}
	throw new Error(
		`Config error: wikis.${ wikiKey }.${ fieldName } must be a string, null, or an {exec: …} object`
	);
}

function runExec( raw: unknown, wikiKey: string, fieldName: SecretFieldName ): string {
	const path = `wikis.${ wikiKey }.${ fieldName }`;
	if ( typeof raw !== 'object' || raw === null ) {
		throw new Error(
			`Config error: ${ path } must be a string, null, or an {exec: …} object`
		);
	}
	const src = raw as { exec?: unknown };
	if ( typeof src.exec !== 'object' || src.exec === null || Array.isArray( src.exec ) ) {
		throw new Error(
			`Config error: ${ path } must be a string, null, or an {exec: …} object`
		);
	}
	const exec = src.exec as { command?: unknown; args?: unknown };
	if ( typeof exec.command !== 'string' || exec.command === '' ) {
		throw new Error( `Config error: ${ path }.exec.command must be a non-empty string` );
	}
	if (
		exec.args !== undefined &&
		(
			!Array.isArray( exec.args ) ||
			!exec.args.every( ( a ) => typeof a === 'string' )
		)
	) {
		throw new Error( `Config error: ${ path }.exec.args must be an array of strings` );
	}
	const command = exec.command;
	const args = ( exec.args as string[] | undefined ) ?? [];

	let stdout: string;
	try {
		stdout = execFileSync( command, args, {
			timeout: 10_000,
			encoding: 'utf-8',
			stdio: [ 'ignore', 'pipe', 'pipe' ]
		} );
	} catch ( err: unknown ) {
		const e = err as NodeJS.ErrnoException & {
			signal?: string;
			status?: number | null;
			stderr?: Buffer | string;
		};
		if ( e.code === 'ENOENT' ) {
			throw new Error(
				`Config error: failed to fetch ${ path }: command "${ command }" not found`
			);
		}
		if ( e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT' ) {
			throw new Error(
				`Config error: failed to fetch ${ path }: command "${ command }" timed out after 10s`
			);
		}
		if ( typeof e.status === 'number' && e.status !== 0 ) {
			const stderrText = e.stderr ?
				( Buffer.isBuffer( e.stderr ) ? e.stderr.toString( 'utf-8' ) : e.stderr ).slice( 0, 200 ) :
				'';
			throw new Error(
				`Config error: failed to fetch ${ path }: command "${ command }" exited with status ${ e.status }. stderr: ${ stderrText }`
			);
		}
		throw new Error(
			`Config error: failed to fetch ${ path }: ${ e.message ?? 'unknown error' }`
		);
	}

	const trimmed = stdout.replace( /\r?\n+$/, '' );
	if ( trimmed === '' ) {
		throw new Error(
			`Config error: failed to fetch ${ path }: command "${ command }" produced no output`
		);
	}
	return trimmed;
}

function resolveWiki( raw: unknown, wikiKey: string ): WikiConfig {
	if ( typeof raw !== 'object' || raw === null || Array.isArray( raw ) ) {
		throw new Error( `Config error: wikis.${ wikiKey } must be an object` );
	}
	const src = raw as Record<string, unknown>;
	const resolved: Record<string, unknown> = {};
	for ( const [ fieldKey, fieldValue ] of Object.entries( src ) ) {
		if ( isSecretField( fieldKey ) ) {
			resolved[ fieldKey ] = resolveSecretField( fieldValue, wikiKey, fieldKey );
		} else {
			resolved[ fieldKey ] = replaceEnvVarsInObject( fieldValue );
		}
	}
	return resolved as unknown as WikiConfig;
}

function resolveConfig( parsed: unknown ): Config {
	if ( typeof parsed !== 'object' || parsed === null || Array.isArray( parsed ) ) {
		throw new Error( 'Config error: config.json must be an object' );
	}
	const p = parsed as Record<string, unknown>;
	const defaultWiki = typeof p.defaultWiki === 'string' ? replaceEnvVars( p.defaultWiki ) : '';
	const allowWikiManagement = typeof p.allowWikiManagement === 'boolean' ? p.allowWikiManagement : undefined;
	const rawWikis = p.wikis;
	if ( typeof rawWikis !== 'object' || rawWikis === null || Array.isArray( rawWikis ) ) {
		return { defaultWiki, wikis: {}, allowWikiManagement };
	}
	const wikis: Record<string, WikiConfig> = {};
	for ( const [ key, rawWiki ] of Object.entries( rawWikis ) ) {
		wikis[ key ] = resolveWiki( rawWiki, key );
	}
	return { defaultWiki, wikis, allowWikiManagement };
}

export function loadConfigFromFile(): Config {
	if ( !fs.existsSync( configPath ) ) {
		return defaultConfig;
	}
	const rawData = fs.readFileSync( configPath, 'utf-8' );
	const parsed = JSON.parse( rawData );
	return resolveConfig( parsed );
}
