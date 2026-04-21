import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Build a response page object shaped as mwn.massQuery returns
// (formatversion=2, prop=revisions, rvslots=main). Slots still need flattening
// by the handler.
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

// For the followRedirects=false path, build the mwn.read-shaped page (flat
// rev: no slots wrapping — mwn.read() already flattens for us).
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

			expect( result.isError ).toBe( true );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'titles' );
		} );

		it( 'more than 50 titles returns validation error', async () => {
			const titles = Array.from( { length: 51 }, ( _, i ) => `T${ i }` );
			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( titles, 'source', false );

			expect( result.isError ).toBe( true );
			expect( ( result.content[ 0 ] as any ).text ).toContain( '50' );
		} );

		it( 'content=none + metadata=false returns validation error', async () => {
			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'none', false );

			expect( result.isError ).toBe( true );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'metadata must be true' );
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

			expect( result.isError ).toBeUndefined();
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

			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts.indexOf( '--- Module:Infobox ---' ) )
				.toBeLessThan( texts.indexOf( '--- Module:Infobox/Person ---' ) );
			expect( texts.indexOf( '--- Module:Infobox/Person ---' ) )
				.toBeLessThan( texts.indexOf( '--- Module:Infobox/Organization ---' ) );
			expect( texts ).toContain( 'A' );
			expect( texts ).toContain( 'B' );
			expect( texts ).toContain( 'C' );
		} );

		it( 'mixed found + missing: emits found pages + Missing block, no isError', async () => {
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

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- Found1 ---' );
			expect( texts ).toContain( '--- Found2 ---' );
			expect( texts ).toContain( 'Missing: NotReal' );
			expect( texts ).not.toContain( '--- NotReal ---' );
		} );

		it( 'all missing: returns only Missing block, no isError', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [
					{ pageid: 0, title: 'A', missing: true },
					{ pageid: 0, title: 'B', missing: true }
				]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'A', 'B' ], 'source', false, true );

			expect( result.isError ).toBeUndefined();
			expect( result.content ).toHaveLength( 1 );
			expect( ( result.content[ 0 ] as any ).text ).toBe( 'Missing: A, B' );
		} );

		it( 'metadata=true emits a metadata block before source for each page', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', true, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- Foo ---' );
			expect( texts ).toContain( 'Page ID: 1' );
			expect( texts ).toContain( 'Latest revision ID: 101' );
			expect( texts ).toContain( 'Content model: wikitext' );
			expect( texts ).toContain( 'Source:\nbody' );
			expect( texts.indexOf( 'Page ID: 1' ) ).toBeLessThan( texts.indexOf( 'body' ) );
			// No Redirected from line when there was no redirect.
			expect( texts ).not.toContain( 'Redirected from' );
		} );

		it( 'content=none + metadata=true returns only metadata, no source', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101 ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'none', true, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( 'Page ID: 1' );
			expect( result.content ).toHaveLength( 2 );
		} );

		it( 'duplicate input titles emit page once', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo', 'Foo' ], 'source', false, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			const matches = texts.match( /--- Foo ---/g ) ?? [];
			expect( matches ).toHaveLength( 1 );
		} );

		it( 'mwn.massQuery throws → isError with wrapped message', async () => {
			const massQuery = vi.fn().mockRejectedValue( new Error( 'API error' ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', false, true );

			expect( result.isError ).toBe( true );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'Failed to retrieve pages' );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'API error' );
		} );

		it( 'redirect followed: emits under requested header, Title shows target, Redirected from line present', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				redirects: [ { from: 'Src', to: 'Tgt' } ],
				pages: [ massQueryPage( 'Tgt', 42, 9001, 'target body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Src' ], 'source', true, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- Src ---' );
			expect( texts ).toContain( 'Title: Tgt' );
			expect( texts ).toContain( 'Redirected from: Src' );
			expect( texts ).toContain( 'Source:\ntarget body' );
		} );

		it( 'normalization only: no Redirected from line', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				normalized: [ { from: 'foo', to: 'Foo' } ],
				pages: [ massQueryPage( 'Foo', 1, 101, 'body' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'foo' ], 'source', true, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- foo ---' );
			expect( texts ).toContain( 'Title: Foo' );
			expect( texts ).not.toContain( 'Redirected from' );
		} );

		it( 'normalized-then-redirect chain: Redirected from shows the requested title', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				normalized: [ { from: 'main page', to: 'Main Page' } ],
				redirects: [ { from: 'Main Page', to: 'Target' } ],
				pages: [ massQueryPage( 'Target', 5, 500, 'target' ) ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'main page' ], 'source', true, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- main page ---' );
			expect( texts ).toContain( 'Title: Target' );
			expect( texts ).toContain( 'Redirected from: main page' );
		} );

		it( 'redirect to missing target: requested title reported as missing', async () => {
			const massQuery = vi.fn().mockResolvedValue( massQueryResponse( {
				redirects: [ { from: 'BrokenRedirect', to: 'Ghost' } ],
				pages: [ { pageid: 0, title: 'Ghost', missing: true } ]
			} ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { massQuery } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'BrokenRedirect' ], 'source', false, true );

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( 'Missing: BrokenRedirect' );
			expect( texts ).not.toContain( '--- BrokenRedirect ---' );
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

			expect( result.isError ).toBeUndefined();
			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			// Only the first one gets emitted under the resolved target.
			const headerMatches = texts.match( /--- Alias[12] ---/g ) ?? [];
			expect( headerMatches ).toHaveLength( 1 );
			expect( headerMatches[ 0 ] ).toBe( '--- Alias1 ---' );
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

			expect( result.isError ).toBeUndefined();
			expect( read ).toHaveBeenCalledTimes( 1 );
			expect( read ).toHaveBeenCalledWith(
				[ 'Main Page' ],
				expect.objectContaining( { redirects: false } )
			);

			const texts = result.content.map( ( c: any ) => c.text ).join( '\n' );
			expect( texts ).toContain( '--- Main Page ---' );
			expect( texts ).toContain( 'Title: Main Page' );
			expect( texts ).not.toContain( 'Redirected from' );
			expect( texts ).toContain( 'Source:\n#REDIRECT [[Target]]' );
		} );

		it( 'mwn.read throws → isError with wrapped message', async () => {
			const read = vi.fn().mockRejectedValue( new Error( 'read error' ) );
			vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { read } ) as any );

			const { handleGetPagesTool } = await import( '../../src/tools/get-pages.js' );
			const result = await handleGetPagesTool( [ 'Foo' ], 'source', false, false );

			expect( result.isError ).toBe( true );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'Failed to retrieve pages' );
			expect( ( result.content[ 0 ] as any ).text ).toContain( 'read error' );
		} );
	} );
} );
