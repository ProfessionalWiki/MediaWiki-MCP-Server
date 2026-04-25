import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
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
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'search-page', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

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
						timestamp: '2026-01-01T00:00:00Z',
						wordcount: 80
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test query', 10 );

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( '- Title: Test Page' );
		expect( text ).toContain( '  Page ID: 1' );
		expect( text ).toContain( '  Snippet: matching <span class="searchmatch">text</span>' );
		expect( text ).toContain( '  Size: 1234' );
		expect( text ).toContain( '  Word count: 80' );
		expect( text ).toContain( '  Timestamp: 2026-01-01T00:00:00Z' );
		expect( text ).toContain( '  URL: https://test.wiki/wiki/Test_Page' );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'returns an empty array when no results found', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { search: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'nonexistent', undefined );

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Results: (none)' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageTool } = await import( '../../src/tools/search-page.js' );
		const result = await handleSearchPageTool( 'test', undefined );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );

	it( 'attaches capped-no-continuation truncation when response.continue is present', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: capped-no-continuation' );
		expect( text ).toContain( '  Returned count: 1' );
		expect( text ).toContain( '  Limit: 10' );
		expect( text ).toContain( '  Item noun: matches' );
	} );

	it( 'omits truncation when response.continue is absent', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'uses the effective default limit in truncation when limit is not provided', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Limit: 10' );
	} );
} );
