import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn()
} ) );

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

function massQueryPage( title: string, pageid: number, revid: number, content?: string ) {
	return {
		pageid,
		title,
		revisions: [ {
			revid,
			timestamp: '2026-04-01T00:00:00Z',
			slots: {
				main: {
					contentmodel: 'wikitext',
					...( content !== undefined ? { content } : {} )
				}
			}
		} ]
	};
}

function massQueryResponse( options: {
	pages?: unknown[];
	redirects?: Array<{ from: string; to: string }>;
	normalized?: Array<{ from: string; to: string }>;
} ): unknown[] {
	return [ {
		query: {
			...( options.pages ? { pages: options.pages } : {} ),
			...( options.redirects ? { redirects: options.redirects } : {} ),
			...( options.normalized ? { normalized: options.normalized } : {} )
		}
	} ];
}

function readPage( title: string, pageid: number, revid: number, content?: string ) {
	return {
		pageid,
		title,
		revisions: [ {
			revid,
			timestamp: '2026-04-01T00:00:00Z',
			contentmodel: 'wikitext',
			...( content !== undefined ? { content } : {} )
		} ]
	};
}

describe( 'get-pages', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	describe( 'validation', () => {
		it( 'empty titles array returns validation error', async () => {
			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [], 'source', false );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'titles' );
		} );

		it( 'more than 50 titles returns validation error', async () => {
			const titles = Array.from( { length: 51 }, ( _, i ) => `T${ i }` );
			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( titles, 'source', false );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( '50' );
		} );

		it( 'content=none + metadata=false returns validation error', async () => {
			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'none', false );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'metadata must be true' );
		} );
	} );

	describe( 'followRedirects=true (default, via massQuery)', () => {
		it( 'returns 3 pages in input order with a single massQuery call', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					massQueryPage( 'Module:Infobox/Person', 2, 102, 'B' ),
					massQueryPage( 'Module:Infobox', 1, 101, 'A' ),
					massQueryPage( 'Module:Infobox/Organization', 3, 103, 'C' )
				]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool(
				[ 'Module:Infobox', 'Module:Infobox/Person', 'Module:Infobox/Organization' ],
				'source',
				false,
				true
			);

			expect( massQuery ).toHaveBeenCalledTimes( 1 );
			expect( massQuery ).toHaveBeenCalledWith(
				expect.objectContaining( {
					action: 'query',
					prop: 'revisions',
					redirects: true,
					formatversion: '2',
					rvslots: 'main'
				} ),
				'titles'
			);

			const text = assertStructuredSuccess( result );
			// Order preserved: input title order, regardless of API response order.
			const requestedTitles = [ ...text.matchAll( /Requested title: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( requestedTitles ).toEqual( [
				'Module:Infobox', 'Module:Infobox/Person', 'Module:Infobox/Organization'
			] );
			const sources = [ ...text.matchAll( /Source: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( sources ).toEqual( [ 'A', 'B', 'C' ] );
			expect( text ).not.toContain( 'Missing:' );
		} );

		it( 'mixed found + missing: emits found pages + missing array, no isError', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					massQueryPage( 'Found1', 1, 101, 'X' ),
					{ pageid: 0, title: 'NotReal', missing: true },
					massQueryPage( 'Found2', 2, 102, 'Y' )
				]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool(
				[ 'Found1', 'NotReal', 'Found2' ], 'source', false, true
			);

			const text = assertStructuredSuccess( result );
			const requestedTitles = [ ...text.matchAll( /Requested title: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( requestedTitles ).toEqual( [ 'Found1', 'Found2' ] );
			expect( text ).toContain( 'Missing:\n- NotReal' );
		} );

		it( 'all missing: returns empty pages array + missing', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					{ pageid: 0, title: 'A', missing: true },
					{ pageid: 0, title: 'B', missing: true }
				]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'A', 'B' ], 'source', false, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Pages: (none)' );
			expect( text ).toContain( 'Missing:\n- A\n- B' );
		} );

		it( 'metadata=true includes revision metadata on each entry', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', true, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Requested title: Foo' );
			expect( text ).toContain( '  Page ID: 1' );
			expect( text ).toContain( '  Title: Foo' );
			expect( text ).toContain( '  Latest revision ID: 101' );
			expect( text ).toContain( '  Content model: wikitext' );
			expect( text ).toContain( '  Source: body' );
			expect( text ).not.toContain( 'Redirected from:' );
		} );

		it( 'content=none + metadata=true returns metadata only, no source', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101 ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'none', true, true );

			const text = assertStructuredSuccess( result );
			const requestedTitles = [ ...text.matchAll( /Requested title: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( requestedTitles ).toHaveLength( 1 );
			expect( text ).toContain( '  Page ID: 1' );
			expect( text ).not.toContain( 'Source:' );
		} );

		it( 'duplicate input titles emit page once', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo', 'Foo' ], 'source', false, true );

			const text = assertStructuredSuccess( result );
			const requestedTitles = [ ...text.matchAll( /Requested title: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( requestedTitles ).toHaveLength( 1 );
		} );

		it( 'mwn.massQuery throws → isError with wrapped message', async () => {
			const massQuery = vi.fn().mockRejectedValue( new Error( 'API error' ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', false, true );

			const envelope = assertStructuredError( result, 'upstream_failure' );
			expect( envelope.message ).toContain( 'Failed to retrieve pages' );
			expect( envelope.message ).toContain( 'API error' );
		} );

		it( 'redirect followed: entry has redirectedFrom and target title', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				redirects: [ { from: 'Src', to: 'Tgt' } ],
				pages: [ massQueryPage( 'Tgt', 42, 9001, 'target body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Src' ], 'source', true, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Requested title: Src' );
			expect( text ).toContain( '  Title: Tgt' );
			expect( text ).toContain( '  Redirected from: Src' );
			expect( text ).toContain( '  Source: target body' );
		} );

		it( 'normalization only: no redirectedFrom', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				normalized: [ { from: 'foo', to: 'Foo' } ],
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'foo' ], 'source', true, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Requested title: foo' );
			expect( text ).toContain( '  Title: Foo' );
			expect( text ).not.toContain( 'Redirected from:' );
		} );

		it( 'normalized-then-redirect chain: redirectedFrom is the requested title', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				normalized: [ { from: 'main page', to: 'Main Page' } ],
				redirects: [ { from: 'Main Page', to: 'Target' } ],
				pages: [ massQueryPage( 'Target', 5, 500, 'target' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'main page' ], 'source', true, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Requested title: main page' );
			expect( text ).toContain( '  Title: Target' );
			expect( text ).toContain( '  Redirected from: main page' );
		} );

		it( 'redirect to missing target: requested title reported as missing', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				redirects: [ { from: 'BrokenRedirect', to: 'Ghost' } ],
				pages: [ { pageid: 0, title: 'Ghost', missing: true } ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'BrokenRedirect' ], 'source', false, true );

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Pages: (none)' );
			expect( text ).toContain( 'Missing:\n- BrokenRedirect' );
		} );

		it( 'two requested titles redirect to same target: emit once', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				redirects: [
					{ from: 'Alias1', to: 'Target' },
					{ from: 'Alias2', to: 'Target' }
				],
				pages: [ massQueryPage( 'Target', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool(
				[ 'Alias1', 'Alias2' ], 'source', true, true
			);

			const text = assertStructuredSuccess( result );
			const requestedTitles = [ ...text.matchAll( /Requested title: (.+)/g ) ].map( ( m ) => m[ 1 ] );
			expect( requestedTitles ).toEqual( [ 'Alias1' ] );
		} );
	} );

	describe( 'followRedirects=false (via mwn.read)', () => {
		it( 'passes redirects: false to mwn.read and emits pseudo-page wikitext under requested title', async () => {
			const read = vi.fn().mockResolvedValue( [
				readPage( 'Main Page', 7, 700, '#REDIRECT [[Target]]' )
			] );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { read } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool(
				[ 'Main Page' ], 'source', true, false
			);

			expect( read ).toHaveBeenCalledTimes( 1 );
			expect( read ).toHaveBeenCalledWith(
				[ 'Main Page' ],
				expect.objectContaining( { redirects: false } )
			);

			const text = assertStructuredSuccess( result );
			expect( text ).toContain( 'Requested title: Main Page' );
			expect( text ).toContain( '  Title: Main Page' );
			expect( text ).toContain( '  Source: #REDIRECT [[Target]]' );
			expect( text ).not.toContain( 'Redirected from:' );
		} );

		it( 'mwn.read throws → isError with wrapped message', async () => {
			const read = vi.fn().mockRejectedValue( new Error( 'read error' ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { read } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', false, false );

			const envelope = assertStructuredError( result, 'upstream_failure' );
			expect( envelope.message ).toContain( 'Failed to retrieve pages' );
			expect( envelope.message ).toContain( 'read error' );
		} );
	} );

	describe( 'byte truncation', () => {
		it( 'truncates oversized content per page with a truncation field on the entry', async () => {
			const big = 'x'.repeat( 50001 );
			const small = 'tiny body';
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					massQueryPage( 'Big', 1, 10, big ),
					massQueryPage( 'Small', 2, 20, small )
				]
			} ) );
			const request = vi.fn()
				.mockResolvedValueOnce( { parse: { sections: [ { line: 'Overview' } ] } } );
			vi.mocked( getMwn ).mockResolvedValue(
				createMockMwn( { massQuery, request } ) as any
			);

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Big', 'Small' ], 'source', false );

			const text = assertStructuredSuccess( result );
			expect( text ).toMatch( /Requested title: Big[\s\S]*?Source:\n\nx{50000}\n {2}Truncation:/ );
			expect( text ).toContain( '    Reason: content-truncated' );
			expect( text ).toContain( '    Returned bytes: 50000' );
			expect( text ).toContain( '    Total bytes: 50001' );
			expect( text ).toContain( '    Item noun: wikitext' );
			expect( text ).toContain( '    Tool name: get-pages' );
			expect( text ).toContain( '    Sections:\n    - (empty)\n    - Overview' );
			expect( text ).toContain( `  Source: ${ small }` );
			// Small entry has no truncation: block under it. We can verify only one Truncation block exists.
			const truncationCount = ( text.match( /Truncation:/g ) ?? [] ).length;
			expect( truncationCount ).toBe( 1 );

			expect( request ).toHaveBeenCalledTimes( 1 );
			expect( request ).toHaveBeenCalledWith( expect.objectContaining( {
				page: 'Big',
				prop: 'sections'
			} ) );
		} );

		it( 'fetches section outlines for multiple truncated pages in parallel, not serially', async () => {
			const big1 = 'a'.repeat( 60000 );
			const big2 = 'b'.repeat( 70000 );
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					massQueryPage( 'BigA', 1, 10, big1 ),
					massQueryPage( 'BigB', 2, 20, big2 )
				]
			} ) );
			let inFlight = 0;
			let maxInFlight = 0;
			const request = vi.fn().mockImplementation( () => {
				inFlight += 1;
				maxInFlight = Math.max( maxInFlight, inFlight );
				return new Promise( ( resolve ) => {
					setTimeout( () => {
						inFlight -= 1;
						resolve( { parse: { sections: [ { line: 'H' } ] } } );
					}, 10 );
				} );
			} );
			vi.mocked( getMwn ).mockResolvedValue(
				createMockMwn( { massQuery, request } ) as any
			);

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'BigA', 'BigB' ], 'source', false );

			const text = assertStructuredSuccess( result );
			expect( request ).toHaveBeenCalledTimes( 2 );
			expect( maxInFlight ).toBe( 2 );
			// Both pages should have a truncation block.
			const truncationCount = ( text.match( /Truncation:/g ) ?? [] ).length;
			expect( truncationCount ).toBe( 2 );
		} );

		it( 'does not emit a truncation for content at exactly 50000 bytes', async () => {
			const exact = 'y'.repeat( 50000 );
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Exact', 1, 10, exact ) ]
			} ) );
			const request = vi.fn();
			vi.mocked( getMwn ).mockResolvedValue(
				createMockMwn( { massQuery, request } ) as any
			);

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Exact' ], 'source', false );

			const text = assertStructuredSuccess( result );
			expect( text ).not.toContain( 'Truncation:' );
			expect( request ).not.toHaveBeenCalled();
		} );
	} );
} );
