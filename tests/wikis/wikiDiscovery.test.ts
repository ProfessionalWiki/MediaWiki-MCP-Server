import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( '../../src/transport/httpFetch.js', () => ( {
	makeApiRequest: vi.fn(),
	fetchPageHtml: vi.fn()
} ) );

vi.mock( '../../src/transport/ssrfGuard.js', () => ( {
	assertPublicDestination: vi.fn()
} ) );

import { makeApiRequest } from '../../src/transport/httpFetch.js';
import { assertPublicDestination } from '../../src/transport/ssrfGuard.js';
import { discoverWiki } from '../../src/wikis/wikiDiscovery.js';

describe( 'discoverWiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		vi.mocked( assertPublicDestination ).mockResolvedValue( undefined );
	} );

	it( 'validates the supplied URL before any fetch', async () => {
		vi.mocked( assertPublicDestination ).mockRejectedValueOnce(
			new Error( 'Refusing to fetch URL resolving to non-public address 10.0.0.1 (private): http://10.0.0.1/' )
		);

		await expect( discoverWiki( 'http://10.0.0.1/' ) ).rejects.toThrow( /non-public/ );
		expect( makeApiRequest ).not.toHaveBeenCalled();
	} );

	it( 'rejects a discovered server URL that resolves to a private address', async () => {
		vi.mocked( makeApiRequest ).mockResolvedValue( {
			query: {
				general: {
					sitename: 'Pretend Wiki',
					scriptpath: '/w',
					articlepath: '/wiki/$1',
					server: 'http://10.0.0.42',
					servername: '10.0.0.42'
				}
			}
		} );
		vi.mocked( assertPublicDestination )
			.mockResolvedValueOnce( undefined )
			.mockRejectedValueOnce(
				new Error( 'Refusing to fetch URL resolving to non-public address 10.0.0.42 (private): http://10.0.0.42' )
			);

		await expect(
			discoverWiki( 'https://public.example/' )
		).rejects.toThrow( /10\.0\.0\.42/ );
	} );

	it( 'returns the WikiInfo when both the input URL and the discovered server are public', async () => {
		vi.mocked( makeApiRequest ).mockResolvedValue( {
			query: {
				general: {
					sitename: 'Public Wiki',
					scriptpath: '/w',
					articlepath: '/wiki/$1',
					server: 'https://public.example',
					servername: 'public.example'
				}
			}
		} );

		const info = await discoverWiki( 'https://public.example/wiki/Main_Page' );

		expect( info ).toEqual( {
			sitename: 'Public Wiki',
			scriptpath: '/w',
			articlepath: '/wiki',
			server: 'https://public.example',
			servername: 'public.example'
		} );
	} );
} );
