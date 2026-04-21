import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

vi.mock( 'fs' );
vi.mock( 'child_process' );

const setConfigFile = ( cfg: unknown ) => {
	vi.mocked( fs.existsSync ).mockReturnValue( true );
	vi.mocked( fs.readFileSync ).mockReturnValue( JSON.stringify( cfg ) );
};

const baseWiki = {
	sitename: 'Test Wiki',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	private: false
};

describe( 'loadConfigFromFile', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		vi.resetModules();
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	} );

	describe( 'no config file', () => {
		it( 'returns defaultConfig when config.json does not exist', async () => {
			vi.mocked( fs.existsSync ).mockReturnValue( false );
			const { loadConfigFromFile, defaultConfig } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile() ).toEqual( defaultConfig );
		} );
	} );

	describe( '${VAR} substitution in secret fields', () => {
		it( 'resolves ${VAR} when the variable is set', async () => {
			vi.stubEnv( 'MY_TOKEN', 'resolved-token' );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${MY_TOKEN}' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().wikis.w.token ).toBe( 'resolved-token' );
		} );

		it( 'throws when ${VAR} in a secret field is not set', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${MISSING_VAR}' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: environment variable "MISSING_VAR" referenced by wikis.w.token is not set'
			);
		} );

		it( 'throws for username and password too', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, username: '${NOPE_U}' } }
			} );
			const { loadConfigFromFile: loadU } = await import( '../../src/common/config.js' );
			expect( () => loadU() ).toThrow(
				'referenced by wikis.w.username'
			);

			vi.resetModules();
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, password: '${NOPE_P}' } }
			} );
			const { loadConfigFromFile: loadP } = await import( '../../src/common/config.js' );
			expect( () => loadP() ).toThrow(
				'referenced by wikis.w.password'
			);
		} );

		it( 'leaves unresolved ${VAR} in non-secret fields as-is', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, sitename: '${NOT_SET}', token: null } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().wikis.w.sitename ).toBe( '${NOT_SET}' );
		} );
	} );

	describe( 'allowWikiManagement', () => {
		it( 'preserves allowWikiManagement: false through the loader', async () => {
			setConfigFile( {
				allowWikiManagement: false,
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().allowWikiManagement ).toBe( false );
		} );
	} );

	describe( 'passthrough cases', () => {
		it( 'passes through null secret fields unchanged', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().wikis.w.token ).toBeNull();
		} );

		it( 'passes through plaintext secrets unchanged (warning comes in a later task)', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: 'plain-secret' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().wikis.w.token ).toBe( 'plain-secret' );
		} );
	} );

	describe( 'plaintext warnings', () => {
		it( 'warns when a secret field is a plaintext literal', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: 'plain-secret-SENTINEL' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
			expect( output ).toContain( 'wikis.w.token' );
			expect( output ).toContain( 'plaintext credential' );
			expect( output ).not.toContain( 'plain-secret-SENTINEL' );
		} );

		it( 'does not warn for resolved ${VAR} secrets', async () => {
			vi.stubEnv( 'SAFE_TOKEN', 'resolved' );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${SAFE_TOKEN}' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
			expect( output ).not.toContain( 'plaintext credential' );
		} );

		it( 'does not warn for null secrets', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, username: null, password: null } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
			expect( output ).not.toContain( 'plaintext credential' );
		} );

		it( 'does not warn for empty-string secrets', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '' } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
			expect( output ).not.toContain( 'plaintext credential' );
		} );

		it( 'warns once per offending field across multiple wikis', async () => {
			setConfigFile( {
				defaultWiki: 'a',
				wikis: {
					a: { ...baseWiki, token: 'xxxxxxx', password: 'yyyyyyy' },
					b: { ...baseWiki, username: 'zzzzzzz' }
				}
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
			expect( output ).toContain( 'wikis.a.token' );
			expect( output ).toContain( 'wikis.a.password' );
			expect( output ).toContain( 'wikis.b.username' );
		} );
	} );

	describe( 'exec credential source', () => {
		const SENTINEL = 'SENTINEL-NEVER-LEAK';

		it( 'resolves secret from trimmed stdout of the exec command', async () => {
			vi.mocked( execFileSync ).mockReturnValue( 'resolved-secret\n' );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: {
					w: {
						...baseWiki,
						token: { exec: { command: 'op', args: [ 'read', 'op://vault/token' ] } }
					}
				}
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( loadConfigFromFile().wikis.w.token ).toBe( 'resolved-secret' );
			expect( vi.mocked( execFileSync ) ).toHaveBeenCalledWith(
				'op',
				[ 'read', 'op://vault/token' ],
				{ timeout: 10000, encoding: 'utf-8', stdio: [ 'ignore', 'pipe', 'pipe' ] }
			);
		} );

		it( 'calls execFileSync with [] when args is omitted', async () => {
			vi.mocked( execFileSync ).mockReturnValue( 'secret' );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: {
					w: { ...baseWiki, token: { exec: { command: 'my-helper' } } }
				}
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			loadConfigFromFile();
			expect( vi.mocked( execFileSync ) ).toHaveBeenCalledWith(
				'my-helper',
				[],
				expect.any( Object )
			);
		} );

		it( 'throws when exec.command is missing or empty', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: '' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: wikis.w.token.exec.command must be a non-empty string'
			);
		} );

		it( 'throws when exec.args is not a string array', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: {
					w: { ...baseWiki, token: { exec: { command: 'op', args: [ 1, 2 ] } } }
				}
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: wikis.w.token.exec.args must be an array of strings'
			);
		} );

		it( 'maps ENOENT to a clear error', async () => {
			vi.mocked( execFileSync ).mockImplementation( () => {
				const e = new Error( 'spawn op ENOENT' ) as NodeJS.ErrnoException;
				e.code = 'ENOENT';
				throw e;
			} );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: failed to fetch wikis.w.token: command "op" not found'
			);
		} );

		it( 'maps timeout (SIGTERM) to a clear error', async () => {
			vi.mocked( execFileSync ).mockImplementation( () => {
				const e = new Error( 'timed out' ) as NodeJS.ErrnoException & { signal?: string };
				e.signal = 'SIGTERM';
				throw e;
			} );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'slow' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: failed to fetch wikis.w.token: command "slow" timed out after 10s'
			);
		} );

		it( 'maps non-zero exit to a clear error with truncated stderr', async () => {
			vi.mocked( execFileSync ).mockImplementation( () => {
				const e = new Error( 'command failed' ) as NodeJS.ErrnoException & {
					status?: number;
					stderr?: Buffer;
				};
				e.status = 1;
				e.stderr = Buffer.from( 'auth required' );
				throw e;
			} );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: failed to fetch wikis.w.token: command "op" exited with status 1. stderr: auth required'
			);
		} );

		it( 'truncates long stderr to 200 chars', async () => {
			const longStderr = 'X'.repeat( 500 );
			vi.mocked( execFileSync ).mockImplementation( () => {
				const e = new Error( 'fail' ) as NodeJS.ErrnoException & {
					status?: number;
					stderr?: Buffer;
				};
				e.status = 2;
				e.stderr = Buffer.from( longStderr );
				throw e;
			} );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			try {
				loadConfigFromFile();
				expect.fail( 'should have thrown' );
			} catch ( err ) {
				const msg = ( err as Error ).message;
				expect( msg ).toContain( 'exited with status 2' );
				// Count Xs in message: should be ≤200
				expect( ( msg.match( /X/g ) ?? [] ).length ).toBeLessThanOrEqual( 200 );
			}
		} );

		it( 'throws when stdout is empty after trim', async () => {
			vi.mocked( execFileSync ).mockReturnValue( '\n\n' );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: failed to fetch wikis.w.token: command "op" produced no output'
			);
		} );

		it( 'throws for a malformed object in a secret field', async () => {
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { wrong: 'shape' } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow(
				'Config error: wikis.w.token must be a string, null, or an {exec: …} object'
			);
		} );

		it( 'never leaks subprocess stdout in error messages', async () => {
			// If the subprocess printed the real secret on stdout and then errored,
			// the error path must not reach into stdout for the message — only stderr.
			vi.mocked( execFileSync ).mockImplementation( () => {
				const e = new Error( 'command failed' ) as NodeJS.ErrnoException & {
					status?: number;
					stderr?: Buffer;
					stdout?: Buffer;
				};
				e.status = 1;
				e.stderr = Buffer.from( 'auth needed' );
				e.stdout = Buffer.from( SENTINEL );
				throw e;
			} );
			setConfigFile( {
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op' } } } }
			} );
			const { loadConfigFromFile } = await import( '../../src/common/config.js' );
			expect( () => loadConfigFromFile() ).toThrow( /exited with status 1/ );
			try {
				loadConfigFromFile();
			} catch ( err ) {
				expect( ( err as Error ).message ).not.toContain( SENTINEL );
			}
		} );
	} );
} );
