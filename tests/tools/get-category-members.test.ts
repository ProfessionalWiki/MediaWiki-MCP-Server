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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Title: Alpha' );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Namespace: 0' );
		expect( text ).toContain( 'Type: page' );
		expect( text ).toContain( 'Title: File:Bar.png' );
		expect( text ).toContain( 'Page ID: 2' );
		expect( text ).toContain( 'Namespace: 6' );
		expect( text ).toContain( 'Type: file' );
		expect( text ).toContain( 'Title: Category:Sub' );
		expect( text ).toContain( 'Page ID: 3' );
		expect( text ).toContain( 'Namespace: 14' );
		expect( text ).toContain( 'Type: subcat' );
		expect( text ).not.toContain( 'Truncation:' );

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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Title: Alpha' );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Namespace: 0' );
		expect( text ).not.toContain( 'Type:' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: more-available' );
		expect( text ).toContain( '  Returned count: 1' );
		expect( text ).toContain( '  Item noun: members' );
		expect( text ).toContain( '  Tool name: get-category-members' );
		expect( text ).toContain( '  Continue with:' );
		expect( text ).toContain( '    Param: continueFrom' );
		expect( text ).toContain( '    Value: page|DOE|456' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'surfaces errors as isError results', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetCategoryMembersTool } = await import( '../../src/tools/get-category-members.js' );
		const result = await handleGetCategoryMembersTool( 'Foo' );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
