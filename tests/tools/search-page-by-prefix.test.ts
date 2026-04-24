import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { TruncationSchema } from '../../src/common/schemas.js';

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

const PrefixResultsSchema = z.object( {
	results: z.array( z.object( {
		title: z.string(),
		pageId: z.number().int().nonnegative(),
		namespace: z.number().int().nonnegative()
	} ) ),
	truncation: TruncationSchema.optional()
} );

describe( 'search-page-by-prefix', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

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

	it( 'returns matching titles as structured results', async () => {
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

		const data = assertStructuredSuccess( result, PrefixResultsSchema );
		expect( data.results ).toEqual( [
			{ title: 'Alpha', pageId: 1, namespace: 0 },
			{ title: 'Alphabet', pageId: 2, namespace: 0 }
		] );
		expect( data.truncation ).toBeUndefined();
	} );

	it( 'returns an empty results array when no matches', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'Zzz', undefined, undefined );

		const data = assertStructuredSuccess( result, PrefixResultsSchema );
		expect( data.results ).toEqual( [] );
		expect( data.truncation ).toBeUndefined();
	} );

	it( 'attaches a capped-no-continuation truncation when response.continue is present', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] },
				continue: { apcontinue: 'B', continue: '-||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'A', 10, undefined );

		const data = assertStructuredSuccess( result, PrefixResultsSchema );
		expect( data.truncation ).toMatchObject( {
			reason: 'capped-no-continuation',
			returnedCount: 1,
			limit: 10,
			itemNoun: 'titles'
		} );
	} );

	it( 'omits truncation when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleSearchPageByPrefixTool } = await import( '../../src/tools/search-page-by-prefix.js' );
		const result = await handleSearchPageByPrefixTool( 'A', undefined, undefined );

		const data = assertStructuredSuccess( result, PrefixResultsSchema );
		expect( data.truncation ).toBeUndefined();
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
