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

describe( 'get-category-members', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'prefixes a bare category name with "Category:" for cmtitle', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [ { pageid: 1, ns: 0, title: 'Foo' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		await handleGetCategoryMembersTool( 'Living people' );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( {
			action: 'query',
			list: 'categorymembers',
			cmtitle: 'Category:Living people'
		} );
	} );

	it( 'preserves an already-prefixed category name', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		await handleGetCategoryMembersTool( 'Category:Foo' );

		expect( mock.request.mock.calls[ 0 ][ 0 ].cmtitle ).toBe( 'Category:Foo' );
	} );

	it( 'forwards types, namespaces, limit, continueFrom to the API', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		await handleGetCategoryMembersTool( 'Foo', [ 'page', 'file' ] as any, [ 0, 6 ], 100, 'page|DOE|123' );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( {
			cmtype: 'page|file',
			cmnamespace: '0|6',
			cmlimit: 100,
			cmcontinue: 'page|DOE|123'
		} );
	} );

	it( 'returns each member as a text block', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [
					{ pageid: 1, ns: 0, title: 'Alpha' },
					{ pageid: 2, ns: 6, title: 'File:Bar.png' }
				] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		expect( result.content ).toHaveLength( 2 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Page ID: 1' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Title: Alpha' );
		expect( ( result.content[ 1 ] as { text: string } ).text ).toContain( 'Namespace: 6' );
	} );

	it( 'appends a more-available marker with a double-quoted continueFrom cursor', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [ { pageid: 1, ns: 0, title: 'A' } ] },
				continue: { cmcontinue: 'page|DOE|456', continue: '-||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toBe(
			'More results available. Returned 1 members. To fetch the next segment, call get-category-members again with continueFrom="page|DOE|456".'
		);
	} );

	it( 'does not append a marker when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [ { pageid: 1, ns: 0, title: 'A' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		for ( const block of result.content ) {
			expect( ( block as { text: string } ).text ).not.toContain( 'More results available' );
		}
	} );

	it( 'surfaces errors as isError results', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );
} );
