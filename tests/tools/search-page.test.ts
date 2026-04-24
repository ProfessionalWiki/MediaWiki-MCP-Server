import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( { getMwn: vi.fn() } ) );
vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );

import { getMwn } from '../../src/common/mwn.js';
import { assertStructuredError } from '../helpers/structuredResult.js';

describe( 'search-page', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'returns full-text search results with snippets', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					search: [ {
						ns: 0,
						title: 'Test Page',
						pageid: 1,
						size: 1234,
						snippet: 'matching <span class="searchmatch">text</span>',
						timestamp: '2026-01-01T00:00:00Z'
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test query', 10 );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Title: Test Page' );
		expect( result.content[ 0 ].text ).toContain( 'Snippet:' );
		expect( result.content[ 0 ].text ).not.toContain( 'Thumbnail' );
		expect( result.content[ 0 ].text ).not.toContain( 'Description' );
	} );

	it( 'returns message when no results found', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { search: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'nonexistent', undefined );

		expect( result.content[ 0 ].text ).toContain( 'No pages found' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test', undefined );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );

	it( 'appends a capped marker when response.continue is present', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					search: [ {
						ns: 0, title: 'Test Page', pageid: 1, size: 1,
						snippet: 's', timestamp: '2026-01-01T00:00:00Z'
					} ]
				},
				continue: { sroffset: 10, continue: '-||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test', 10 );

		expect( result.isError ).toBeUndefined();
		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toBe(
			'Result capped at 10 matches. Additional matches may exist — narrow the query or raise limit (max 100).'
		);
	} );

	it( 'does not append a marker when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					search: [ {
						ns: 0, title: 'A', pageid: 1, size: 1,
						snippet: 's', timestamp: '2026-01-01T00:00:00Z'
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test', 10 );

		for ( const block of result.content ) {
			expect( ( block as { text: string } ).text ).not.toContain( 'Result capped' );
			expect( ( block as { text: string } ).text ).not.toContain( 'More results available' );
		}
	} );

	it( 'uses the effective limit in the marker when no limit was provided', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					search: [ {
						ns: 0, title: 'A', pageid: 1, size: 1,
						snippet: 's', timestamp: '2026-01-01T00:00:00Z'
					} ]
				},
				continue: { sroffset: 10 }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test', undefined );

		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toContain( 'Result capped at 10 matches' );
	} );
} );
