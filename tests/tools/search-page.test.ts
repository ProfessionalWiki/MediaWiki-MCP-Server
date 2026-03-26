import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( { getMwn: vi.fn() } ) );
vi.mock( '../../src/server.js', () => ( { USER_AGENT: 'test-agent' } ) );
vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );

import { getMwn } from '../../src/common/mwn.js';

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

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'API error' );
	} );
} );
