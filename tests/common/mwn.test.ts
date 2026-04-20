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

		expect( result ).toBe( oauthInstance );
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

		expect( result ).toBe( loginInstance );
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
