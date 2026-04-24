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

describe( 'search-page-by-prefix', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'calls action=query&list=allpages with apprefix and aplimit', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'Foo' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		await handleSearchPageByPrefixTool( 'F', 50, 0 );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( {
			action: 'query',
			list: 'allpages',
			apprefix: 'F',
			aplimit: 50,
			apnamespace: 0
		} );
	} );

	it( 'returns matching titles as text blocks', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [
					{ pageid: 1, ns: 0, title: 'Alpha' },
					{ pageid: 2, ns: 0, title: 'Alphabet' }
				] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'Alph', undefined, undefined );

		expect( result.content ).toHaveLength( 2 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toBe( 'Alpha' );
		expect( ( result.content[ 1 ] as { text: string } ).text ).toBe( 'Alphabet' );
	} );

	it( 'returns empty-state message when no matches', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'Zzz', undefined, undefined );

		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'No pages found with the prefix' );
	} );

	it( 'appends a capped marker when response.continue is present', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] },
				continue: { apcontinue: 'B', continue: '-||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'A', 10, undefined );

		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toBe(
			'Result capped at 10 titles. Additional titles may exist — narrow the prefix or raise limit (max 500).'
		);
	} );

	it( 'does not append a marker when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'A', undefined, undefined );

		for ( const block of result.content ) {
			expect( ( block as { text: string } ).text ).not.toContain( 'Result capped' );
		}
	} );

	it( 'surfaces errors as isError results', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'A', undefined, undefined );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );
} );
