import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { CategoryMemberSchema, TruncationSchema } from '../../src/common/schemas.js';

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

const CategoryMembersSchema = z.object( {
	members: z.array( CategoryMemberSchema ),
	truncation: TruncationSchema.optional()
} );

describe( 'get-category-members', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

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

	it( 'returns each member as a structured entry with type surfaced', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [
					{ pageid: 1, ns: 0, title: 'Alpha', type: 'page' },
					{ pageid: 2, ns: 6, title: 'File:Bar.png', type: 'file' },
					{ pageid: 3, ns: 14, title: 'Category:Sub', type: 'subcat' }
				] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const data = assertStructuredSuccess( result, CategoryMembersSchema );
		expect( data.members ).toEqual( [
			{ title: 'Alpha', pageId: 1, namespace: 0, type: 'page' },
			{ title: 'File:Bar.png', pageId: 2, namespace: 6, type: 'file' },
			{ title: 'Category:Sub', pageId: 3, namespace: 14, type: 'subcat' }
		] );
		expect( data.truncation ).toBeUndefined();

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call.cmprop ).toBe( 'ids|title|type' );
	} );

	it( 'omits type from entries when MediaWiki omits it', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [
					{ pageid: 1, ns: 0, title: 'Alpha' }
				] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const data = assertStructuredSuccess( result, CategoryMembersSchema );
		expect( data.members ).toEqual( [
			{ title: 'Alpha', pageId: 1, namespace: 0 }
		] );
		expect( data.members[ 0 ].type ).toBeUndefined();
	} );

	it( 'attaches a more-available truncation with the continueFrom cursor', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [ { pageid: 1, ns: 0, title: 'A' } ] },
				continue: { cmcontinue: 'page|DOE|456', continue: '-||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const data = assertStructuredSuccess( result, CategoryMembersSchema );
		expect( data.truncation ).toEqual( {
			reason: 'more-available',
			returnedCount: 1,
			itemNoun: 'members',
			toolName: 'get-category-members',
			continueWith: { param: 'continueFrom', value: 'page|DOE|456' }
		} );
	} );

	it( 'omits truncation when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { categorymembers: [ { pageid: 1, ns: 0, title: 'A' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const data = assertStructuredSuccess( result, CategoryMembersSchema );
		expect( data.truncation ).toBeUndefined();
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
