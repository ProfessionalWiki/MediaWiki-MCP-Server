import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock( '../../src/wikis/state.js', () => ( {
	wikiRegistry: {
		getAll: () => ( { 'a.example': { sitename: 'A', server: 'https://a' } } ),
		get: () => undefined,
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => false
	},
	wikiSelection: {
		getCurrent: () => ( { key: 'a.example', config: {} } ),
		setCurrent: () => {},
		reset: () => {}
	},
	uploadDirs: { list: () => [] },
	mwnProvider: {
		get: () => Promise.reject( new Error( 'mwn not available in tests' ) ),
		invalidate: () => {}
	},
	licenseCache: {
		get: () => undefined,
		set: () => {},
		delete: () => {}
	}
} ) );

import { emitStartupBanner } from '../../src/runtime/banner.js';

function captureLines( spy: ReturnType<typeof vi.spyOn> ): Record<string, unknown>[] {
	return spy.mock.calls
		.map( ( c ) => String( c[ 0 ] ) )
		.filter( ( s ) => s.startsWith( '{' ) )
		.map( ( s ) => JSON.parse( s.slice( 0, -1 ) ) as Record<string, unknown> );
}

describe( 'startup banner', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stderrSpy.mockRestore();
	} );

	it( 'emits exactly one startup event for stdio', () => {
		emitStartupBanner( { transport: 'stdio' } );

		const events = captureLines( stderrSpy ).filter( ( e ) => e.event === 'startup' );
		expect( events ).toHaveLength( 1 );
		const e = events[ 0 ];
		expect( e.transport ).toBe( 'stdio' );
		expect( typeof e.version ).toBe( 'string' );
		expect( e.auth_shape ).toBe( 'anonymous' );
		expect( e.wikis ).toEqual( [ 'a.example' ] );
		expect( e.default_wiki ).toBe( 'a.example' );
		expect( e.allow_wiki_management ).toBe( false );
		expect( e.upload_dirs_configured ).toBe( false );
		expect( 'host' in e ).toBe( false );
		expect( 'port' in e ).toBe( false );
		expect( 'allowed_hosts' in e ).toBe( false );
		expect( 'allowed_origins' in e ).toBe( false );
		expect( 'max_request_body' in e ).toBe( false );
	} );

	it( 'includes http fields when transport is http', () => {
		emitStartupBanner( {
			transport: 'http',
			http: {
				host: '0.0.0.0',
				port: 8080,
				allowedHosts: [ 'wiki.example.org' ],
				allowedOrigins: [ 'https://wiki.example.org' ],
				maxRequestBody: '2mb'
			}
		} );

		const events = captureLines( stderrSpy ).filter( ( e ) => e.event === 'startup' );
		expect( events ).toHaveLength( 1 );
		const e = events[ 0 ];
		expect( e.transport ).toBe( 'http' );
		expect( e.host ).toBe( '0.0.0.0' );
		expect( e.port ).toBe( 8080 );
		expect( e.auth_shape ).toBe( 'bearer-passthrough' );
		expect( e.allowed_hosts ).toEqual( [ 'wiki.example.org' ] );
		expect( e.allowed_origins ).toEqual( [ 'https://wiki.example.org' ] );
		expect( e.max_request_body ).toBe( '2mb' );
	} );

	it( 'omits allowed_hosts/origins when not provided but always emits max_request_body', () => {
		emitStartupBanner( {
			transport: 'http',
			http: { host: '127.0.0.1', port: 3000, maxRequestBody: '1mb' }
		} );

		const e = captureLines( stderrSpy ).find( ( x ) => x.event === 'startup' );
		expect( e ).toBeDefined();
		expect( e!.host ).toBe( '127.0.0.1' );
		expect( 'allowed_hosts' in e! ).toBe( false );
		expect( 'allowed_origins' in e! ).toBe( false );
		expect( e!.max_request_body ).toBe( '1mb' );
	} );

	it( 'classifies static-credential and never logs the token value', async () => {
		vi.resetModules();
		vi.doMock( '../../src/wikis/state.js', () => ( {
			wikiRegistry: {
				getAll: () => ( {
					'a.example': { sitename: 'A', server: 'https://a', token: 'SUPER-SECRET' }
				} ),
				get: () => undefined,
				add: () => {},
				remove: () => {},
				isManagementAllowed: () => false
			},
			wikiSelection: {
				getCurrent: () => ( { key: 'a.example', config: {} } ),
				setCurrent: () => {},
				reset: () => {}
			},
			uploadDirs: { list: () => [] },
			mwnProvider: {
				get: () => Promise.reject( new Error( 'mwn not available in tests' ) ),
				invalidate: () => {}
			},
			licenseCache: {
				get: () => undefined,
				set: () => {},
				delete: () => {}
			}
		} ) );

		const { emitStartupBanner: esb } = await import( '../../src/runtime/banner.js' );
		esb( { transport: 'stdio' } );

		const allOutput = stderrSpy.mock.calls.map( ( c ) => String( c[ 0 ] ) ).join( '' );
		expect( allOutput ).not.toContain( 'SUPER-SECRET' );

		const events = captureLines( stderrSpy ).filter( ( e ) => e.event === 'startup' );
		expect( events[ 0 ].auth_shape ).toBe( 'static-credential' );
	} );
} );
