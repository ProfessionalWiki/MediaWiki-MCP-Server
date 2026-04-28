import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { searchPage } from '../../src/tools/search-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'search-page', () => {
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPage.handle( { query: 'test query', limit: 10 }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( '- Title: Test Page' );
		expect( text ).toContain( '  Page ID: 1' );
		expect( text ).toContain( '  Snippet: matching <span class="searchmatch">text</span>' );
		expect( text ).toContain( '  Size: 1234' );
		expect( text ).toContain( '  Word count: 80' );
		expect( text ).toContain( '  Timestamp: 2026-01-01T00:00:00Z' );
		expect( text ).toMatch( /URL: .*\/wiki\/Test_Page/ );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'returns an empty array when no results found', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { search: [] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPage.handle( { query: 'nonexistent' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Results: (none)' );
	} );

	it( 'returns error on failure via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( searchPage, ctx )( { query: 'test' } );

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPage.handle( { query: 'test', limit: 10 }, ctx );

		const text = assertStructuredSuccess( result );
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPage.handle( { query: 'test', limit: 10 }, ctx );

		const text = assertStructuredSuccess( result );
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPage.handle( { query: 'test' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Limit: 10' );
	} );
} );
