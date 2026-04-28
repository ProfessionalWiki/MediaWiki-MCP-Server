import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response } from 'node-fetch';

vi.mock( 'node-fetch', async () => {
	const actual = await vi.importActual<typeof import( 'node-fetch' )>( 'node-fetch' );
	return {
		...actual,
		default: vi.fn()
	};
} );

vi.mock( '../../src/transport/ssrfGuard.js', () => ( {
	assertPublicDestination: vi.fn(),
	buildPinnedAgent: vi.fn()
} ) );

import fetch from 'node-fetch';
import { assertPublicDestination, buildPinnedAgent } from '../../src/transport/ssrfGuard.js';
import { makeApiRequest, fetchPageHtml } from '../../src/transport/httpFetch.js';

describe( 'utils.fetchCore (via makeApiRequest / fetchPageHtml)', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		vi.mocked( assertPublicDestination ).mockResolvedValue( [
			{ address: '93.184.216.34', family: 4 }
		] );
		vi.mocked( buildPinnedAgent ).mockReturnValue( { __pinned: true } as never );
	} );

	it( 'calls assertPublicDestination with the final URL before fetching', async () => {
		vi.mocked( fetch ).mockResolvedValueOnce( new Response( '{}', { status: 200 } ) );

		await makeApiRequest( 'https://example.com/w/api.php', { action: 'query' } );

		expect( assertPublicDestination ).toHaveBeenCalledWith(
			'https://example.com/w/api.php?action=query'
		);
		expect( fetch ).toHaveBeenCalledWith(
			'https://example.com/w/api.php?action=query',
			expect.objectContaining( { redirect: 'manual' } )
		);
	} );

	it( 'pins DNS by passing an Agent built from the resolved addresses to fetch', async () => {
		const resolved = [ { address: '93.184.216.34', family: 4 as const } ];
		vi.mocked( assertPublicDestination ).mockResolvedValueOnce( resolved );
		const pinned = { __pinned: 'v4-agent' } as never;
		vi.mocked( buildPinnedAgent ).mockReturnValueOnce( pinned );
		vi.mocked( fetch ).mockResolvedValueOnce( new Response( '{}', { status: 200 } ) );

		await makeApiRequest( 'https://example.com/w/api.php' );

		expect( buildPinnedAgent ).toHaveBeenCalledWith(
			'https://example.com/w/api.php',
			resolved
		);
		expect( fetch ).toHaveBeenCalledWith(
			'https://example.com/w/api.php',
			expect.objectContaining( { agent: pinned } )
		);
	} );

	it( 'rebuilds the pinned Agent per redirect hop from fresh resolved addresses', async () => {
		const firstHop = [ { address: '93.184.216.34', family: 4 as const } ];
		const secondHop = [ { address: '151.101.1.69', family: 4 as const } ];
		vi.mocked( assertPublicDestination )
			.mockResolvedValueOnce( firstHop )
			.mockResolvedValueOnce( secondHop );
		const firstAgent = { __pinned: 'first' } as never;
		const secondAgent = { __pinned: 'second' } as never;
		vi.mocked( buildPinnedAgent )
			.mockReturnValueOnce( firstAgent )
			.mockReturnValueOnce( secondAgent );
		vi.mocked( fetch )
			.mockResolvedValueOnce(
				new Response( null, { status: 302, headers: { Location: 'https://other.example/api.php' } } )
			)
			.mockResolvedValueOnce( new Response( '{"ok":true}', { status: 200 } ) );

		await makeApiRequest<{ ok: boolean }>( 'https://start.example/api.php' );

		expect( buildPinnedAgent ).toHaveBeenNthCalledWith( 1, 'https://start.example/api.php', firstHop );
		expect( buildPinnedAgent ).toHaveBeenNthCalledWith( 2, 'https://other.example/api.php', secondHop );
		expect( fetch ).toHaveBeenNthCalledWith(
			1,
			'https://start.example/api.php',
			expect.objectContaining( { agent: firstAgent } )
		);
		expect( fetch ).toHaveBeenNthCalledWith(
			2,
			'https://other.example/api.php',
			expect.objectContaining( { agent: secondAgent } )
		);
	} );

	it( 'throws without calling fetch when the guard rejects the URL', async () => {
		vi.mocked( assertPublicDestination ).mockRejectedValueOnce(
			new Error( 'Refusing to fetch URL resolving to non-public address 127.0.0.1 (loopback): http://127.0.0.1/' )
		);

		await expect(
			makeApiRequest( 'http://127.0.0.1/w/api.php' )
		).rejects.toThrow( /non-public/ );
		expect( fetch ).not.toHaveBeenCalled();
	} );

	it( 'fetchPageHtml swallows guard rejections and returns null', async () => {
		vi.mocked( assertPublicDestination ).mockRejectedValueOnce(
			new Error( 'Refusing to fetch URL with unsupported scheme "file:": file:///etc/passwd' )
		);

		const result = await fetchPageHtml( 'file:///etc/passwd' );

		expect( result ).toBeNull();
		expect( fetch ).not.toHaveBeenCalled();
	} );

	it( 'follows a 302 redirect only after the guard approves the Location target', async () => {
		vi.mocked( fetch )
			.mockResolvedValueOnce(
				new Response( null, { status: 302, headers: { Location: 'https://redirected.example/api.php' } } )
			)
			.mockResolvedValueOnce( new Response( '{"ok":true}', { status: 200 } ) );

		const result = await makeApiRequest<{ ok: boolean }>( 'https://start.example/api.php' );

		expect( result ).toEqual( { ok: true } );
		expect( assertPublicDestination ).toHaveBeenNthCalledWith( 1, 'https://start.example/api.php' );
		expect( assertPublicDestination ).toHaveBeenNthCalledWith( 2, 'https://redirected.example/api.php' );
		expect( fetch ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'rejects a redirect whose Location resolves to a private address', async () => {
		vi.mocked( fetch ).mockResolvedValueOnce(
			new Response( null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } } )
		);
		vi.mocked( assertPublicDestination )
			.mockResolvedValueOnce( undefined )
			.mockRejectedValueOnce(
				new Error( 'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): http://169.254.169.254/latest/meta-data/' )
			);

		await expect(
			makeApiRequest( 'https://start.example/api.php' )
		).rejects.toThrow( /169\.254\.169\.254/ );
		expect( fetch ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'resolves a protocol-relative Location against the previous URL before revalidating', async () => {
		vi.mocked( fetch )
			.mockResolvedValueOnce(
				new Response( null, { status: 302, headers: { Location: '//other.example/api.php' } } )
			)
			.mockResolvedValueOnce( new Response( '{"ok":true}', { status: 200 } ) );

		await makeApiRequest( 'https://start.example/api.php' );

		expect( assertPublicDestination ).toHaveBeenNthCalledWith( 2, 'https://other.example/api.php' );
	} );

	it( 'resolves a path-only Location against the previous URL before revalidating', async () => {
		vi.mocked( fetch )
			.mockResolvedValueOnce(
				new Response( null, { status: 302, headers: { Location: '/elsewhere/api.php' } } )
			)
			.mockResolvedValueOnce( new Response( '{"ok":true}', { status: 200 } ) );

		await makeApiRequest( 'https://start.example/w/api.php' );

		expect( assertPublicDestination ).toHaveBeenNthCalledWith( 2, 'https://start.example/elsewhere/api.php' );
	} );

	it( 'caps the redirect chain at five hops', async () => {
		for ( let i = 0; i < 10; i++ ) {
			vi.mocked( fetch ).mockResolvedValueOnce(
				new Response( null, { status: 302, headers: { Location: `https://hop${ i + 1 }.example/` } } )
			);
		}

		await expect(
			makeApiRequest( 'https://start.example/api.php' )
		).rejects.toThrow( /redirect/i );
		expect( fetch.mock ? fetch.mock.calls.length : vi.mocked( fetch ).mock.calls.length )
			.toBeLessThanOrEqual( 6 );
	} );
} );
