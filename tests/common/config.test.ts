import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

vi.mock( 'fs' );

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
} );
