import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMwnInstance = ( id: string ) => ( { id } );

const mockInit = vi.fn();
const mockConstructor = vi.fn();
const mockGetSiteInfo = vi.fn();

vi.mock( 'mwn', () => ( {
	Mwn: class MockMwn {
		id: string;
		constructor( options: unknown ) {
			mockConstructor( options );
			Object.assign( this, mockMwnInstance( 'anonymous' ) );
		}
		getSiteInfo = mockGetSiteInfo;
		static init = mockInit;
	}
} ) );

vi.mock( '../../src/server.js', () => ( {
	USER_AGENT: 'test-agent'
} ) );

vi.mock( '../../src/common/requestContext.js', () => {
	let token: string | undefined;
	return {
		getRuntimeToken: () => token,
		_setRuntimeToken: ( t: string | undefined ) => {
			token = t;
		}
	};
} );

let currentWikiKey = 'wiki-a';
let currentWikiConfig: Record<string, unknown> = {
	server: 'https://wiki-a.example.com',
	scriptpath: '/w'
};

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: () => ( {
			key: currentWikiKey,
			config: currentWikiConfig
		} )
	}
} ) );

let getMwn: typeof import( '../../src/common/mwn.js' ).getMwn;
let removeMwnInstance: typeof import( '../../src/common/mwn.js' ).removeMwnInstance;
let setRuntimeToken: ( t: string | undefined ) => void;

describe( 'mwn instance management', () => {

	beforeEach( async () => {
		vi.resetModules();
		mockInit.mockReset();
		mockConstructor.mockReset();
		mockGetSiteInfo.mockReset();

		currentWikiKey = 'wiki-a';
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w'
		};

		const mwnModule = await import( '../../src/common/mwn.js' );
		getMwn = mwnModule.getMwn;
		removeMwnInstance = mwnModule.removeMwnInstance;

		const contextModule = await import( '../../src/common/requestContext.js' );
		setRuntimeToken = ( contextModule as unknown as { _setRuntimeToken: ( t: string | undefined ) => void } )._setRuntimeToken;
		setRuntimeToken( undefined );
	} );

	it( 'returns cached instance for same wiki key', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const first = await getMwn();
		const second = await getMwn();

		expect( first ).toBe( second );
		expect( mockConstructor ).toHaveBeenCalledOnce();
	} );

	it( 'returns different instances for different wiki keys', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const firstInstance = await getMwn();

		currentWikiKey = 'wiki-b';
		currentWikiConfig = {
			server: 'https://wiki-b.example.com',
			scriptpath: '/w'
		};

		const secondInstance = await getMwn();

		expect( firstInstance ).not.toBe( secondInstance );
		expect( mockConstructor ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'returns the original cached instance after switching away and back', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const firstA = await getMwn();

		currentWikiKey = 'wiki-b';
		currentWikiConfig = {
			server: 'https://wiki-b.example.com',
			scriptpath: '/w'
		};
		await getMwn();

		currentWikiKey = 'wiki-a';
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w'
		};
		const secondA = await getMwn();

		expect( secondA ).toBe( firstA );
		expect( mockConstructor ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'deduplicates concurrent first-calls for the same wiki', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const [ first, second ] = await Promise.all( [ getMwn(), getMwn() ] );

		expect( first ).toBe( second );
		expect( mockConstructor ).toHaveBeenCalledOnce();
		expect( mockGetSiteInfo ).toHaveBeenCalledOnce();
	} );

	it( 'removes a failed instance from the cache so the next call retries', async () => {
		mockGetSiteInfo
			.mockRejectedValueOnce( new Error( 'transient failure' ) )
			.mockResolvedValueOnce( undefined );

		await expect( getMwn() ).rejects.toThrow( 'transient failure' );

		// Next call should retry (not return the cached rejected Promise).
		const retry = await getMwn();
		expect( retry ).toBeDefined();
		expect( mockConstructor ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'removeMwnInstance clears the correct entry', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		await getMwn();

		removeMwnInstance( 'wiki-a' );

		const newInstance = await getMwn();
		expect( mockConstructor ).toHaveBeenCalledTimes( 2 );
		expect( newInstance ).toBeDefined();
	} );

	it( 'removeMwnInstance does not affect other entries', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const instanceA = await getMwn();

		currentWikiKey = 'wiki-b';
		currentWikiConfig = {
			server: 'https://wiki-b.example.com',
			scriptpath: '/w'
		};

		const instanceB = await getMwn();

		removeMwnInstance( 'wiki-a' );

		currentWikiKey = 'wiki-b';
		const instanceBAgain = await getMwn();

		expect( instanceBAgain ).toBe( instanceB );
		expect( instanceA ).not.toBe( instanceB );
	} );

	it( 'uses Mwn.init with OAuth2 token when configured', async () => {
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w',
			token: 'my-oauth-token'
		};
		const oauthInstance = { id: 'oauth' };
		mockInit.mockResolvedValue( oauthInstance );

		const result = await getMwn();

		// Instance is wrapped in a token-redacting Proxy; structural equality holds.
		expect( result ).toEqual( oauthInstance );
		expect( mockInit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				OAuth2AccessToken: 'my-oauth-token'
			} )
		);
	} );

	it( 'uses Mwn.init with username/password when configured', async () => {
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w',
			username: 'user',
			password: 'pass'
		};
		const loginInstance = { id: 'login' };
		mockInit.mockResolvedValue( loginInstance );

		const result = await getMwn();

		expect( result ).toEqual( loginInstance );
		expect( mockInit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				username: 'user',
				password: 'pass'
			} )
		);
	} );

	it( 'uses anonymous access with getSiteInfo when no credentials', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		const result = await getMwn();

		expect( result ).toBeDefined();
		expect( mockInit ).not.toHaveBeenCalled();
		expect( mockGetSiteInfo ).toHaveBeenCalledOnce();
	} );
} );

describe( 'runtime token', () => {

	beforeEach( async () => {
		vi.resetModules();
		mockInit.mockReset();
		mockConstructor.mockReset();
		mockGetSiteInfo.mockReset();

		currentWikiKey = 'wiki-a';
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w'
		};

		const mwnModule = await import( '../../src/common/mwn.js' );
		getMwn = mwnModule.getMwn;
		removeMwnInstance = mwnModule.removeMwnInstance;

		const contextModule = await import( '../../src/common/requestContext.js' );
		setRuntimeToken = ( contextModule as unknown as { _setRuntimeToken: ( t: string | undefined ) => void } )._setRuntimeToken;
		setRuntimeToken( undefined );
	} );

	it( 'uses runtime token over config token', async () => {
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w',
			token: 'config-fallback'
		};
		const oauthInstance = { id: 'runtime' };
		mockInit.mockResolvedValue( oauthInstance );
		setRuntimeToken( 'runtime-token-X' );

		const result = await getMwn();

		expect( result ).toEqual( oauthInstance );
		expect( mockInit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				OAuth2AccessToken: 'runtime-token-X'
			} )
		);
	} );

	it( 'uses runtime token when config has no credentials', async () => {
		const oauthInstance = { id: 'runtime-no-config' };
		mockInit.mockResolvedValue( oauthInstance );
		setRuntimeToken( 'runtime-token-Y' );

		const result = await getMwn();

		expect( result ).toEqual( oauthInstance );
		expect( mockInit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				OAuth2AccessToken: 'runtime-token-Y'
			} )
		);
	} );

	it( 'falls back to config token when no runtime token', async () => {
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w',
			token: 'config-token'
		};
		const oauthInstance = { id: 'config' };
		mockInit.mockResolvedValue( oauthInstance );

		const result = await getMwn();

		expect( result ).toEqual( oauthInstance );
		expect( mockInit ).toHaveBeenCalledWith(
			expect.objectContaining( {
				OAuth2AccessToken: 'config-token'
			} )
		);
	} );

	it( 'does not cache runtime-token instances', async () => {
		mockInit.mockResolvedValue( { id: 'first' } );
		setRuntimeToken( 'same-token' );

		await getMwn();

		mockInit.mockResolvedValue( { id: 'second' } );

		const second = await getMwn();

		expect( second ).toEqual( { id: 'second' } );
		expect( mockInit ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'runtime-token calls do not pollute the config cache', async () => {
		mockGetSiteInfo.mockResolvedValue( undefined );

		// First: anonymous (cached)
		const anon = await getMwn();

		// Second: runtime token (should not affect cache)
		mockInit.mockResolvedValue( { id: 'runtime' } );
		setRuntimeToken( 'runtime-token-Z' );
		await getMwn();

		// Third: back to anonymous (should be cache hit)
		setRuntimeToken( undefined );
		const anonAgain = await getMwn();

		expect( anonAgain ).toBe( anon );
		expect( mockConstructor ).toHaveBeenCalledOnce();
	} );

	it( 'redacts token from error message', async () => {
		setRuntimeToken( 'secret-token-123' );
		mockInit.mockRejectedValue( new Error( 'OAuth failed: secret-token-123 is invalid' ) );

		await expect( getMwn() ).rejects.toThrow( /\[REDACTED\]/ );
		await expect( getMwn() ).rejects.not.toThrow( /secret-token-123/ );
	} );

	it( 'redacts Authorization headers on request, config, and response of error objects', async () => {
		const err = new Error( 'connection failed' );
		( err as Record<string, unknown> ).request = {
			headers: { Authorization: 'Bearer secret' }
		};
		( err as Record<string, unknown> ).config = {
			url: 'https://...',
			headers: { Authorization: 'Bearer secret' }
		};
		( err as Record<string, unknown> ).response = {
			config: { headers: { Authorization: 'Bearer secret' } }
		};

		setRuntimeToken( 'secret' );
		mockInit.mockRejectedValue( err );

		try {
			await getMwn();
			expect.unreachable( 'should have thrown' );
		} catch ( caught ) {
			const c = caught as {
				request: { headers: Record<string, string> };
				config: { headers: Record<string, string> };
				response: { config: { headers: Record<string, string> } };
			};
			expect( c.request.headers.Authorization ).toBe( '[REDACTED]' );
			expect( c.config.headers.Authorization ).toBe( '[REDACTED]' );
			expect( c.response.config.headers.Authorization ).toBe( '[REDACTED]' );
		}
	} );
} );

describe( 'post-init error redaction', () => {
	beforeEach( async () => {
		vi.resetModules();
		mockInit.mockReset();
		mockConstructor.mockReset();
		mockGetSiteInfo.mockReset();
		currentWikiKey = 'wiki-a';
		currentWikiConfig = {
			server: 'https://wiki-a.example.com',
			scriptpath: '/w'
		};
		const mwnModule = await import( '../../src/common/mwn.js' );
		getMwn = mwnModule.getMwn;
		removeMwnInstance = mwnModule.removeMwnInstance;
		const ctx = await import( '../../src/common/requestContext.js' );
		setRuntimeToken = ( ctx as unknown as { _setRuntimeToken: typeof setRuntimeToken } )._setRuntimeToken;
		setRuntimeToken( undefined );
	} );

	it( 'redacts Authorization on errors thrown by mwn methods after init', async () => {
		const save = vi.fn().mockRejectedValue(
			Object.assign( new Error( 'bad token' ), {
				request: { headers: { Authorization: 'Bearer runtime-secret' } }
			} )
		);
		mockInit.mockResolvedValueOnce( { save, id: 'wiki-a' } );
		setRuntimeToken( 'runtime-secret' );

		const instance = await getMwn();
		await expect( ( instance as unknown as { save: () => Promise<unknown> } ).save() )
			.rejects.toMatchObject( {
				request: { headers: { Authorization: '[REDACTED]' } }
			} );
	} );

	it( 'redacts token substrings and Authorization in init-time error messages', async () => {
		mockInit.mockRejectedValueOnce(
			Object.assign( new Error( 'init failed for Bearer init-secret' ), {
				config: { headers: { Authorization: 'Bearer init-secret' } }
			} )
		);
		setRuntimeToken( 'init-secret' );

		const rejection = getMwn();
		await expect( rejection ).rejects.toMatchObject( {
			config: { headers: { Authorization: '[REDACTED]' } }
		} );
		await rejection.catch( ( err: Error ) => {
			expect( err.message ).toContain( '[REDACTED]' );
			expect( err.message ).not.toContain( 'init-secret' );
		} );
	} );
} );
