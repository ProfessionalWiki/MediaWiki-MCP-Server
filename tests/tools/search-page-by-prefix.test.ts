import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { searchPageByPrefix } from '../../src/tools/search-page-by-prefix.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'search-page-by-prefix', () => {
	it( 'calls action=query&list=allpages with apprefix and aplimit', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'Foo' } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await searchPageByPrefix.handle( { prefix: 'F', limit: 50, namespace: 0 }, ctx );

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPageByPrefix.handle( { prefix: 'Alph' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( '- Title: Alpha' );
		expect( text ).toContain( '  Page ID: 1' );
		expect( text ).toContain( '- Title: Alphabet' );
		expect( text ).toContain( '  Page ID: 2' );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'returns an empty results array when no matches', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPageByPrefix.handle( { prefix: 'Zzz' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Results: (none)' );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'attaches a capped-no-continuation truncation when response.continue is present', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] },
				continue: { apcontinue: 'B', continue: '-||' }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPageByPrefix.handle( { prefix: 'A', limit: 10 }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: capped-no-continuation' );
		expect( text ).toContain( '  Returned count: 1' );
		expect( text ).toContain( '  Limit: 10' );
		expect( text ).toContain( '  Item noun: titles' );
	} );

	it( 'omits truncation when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { allpages: [ { pageid: 1, ns: 0, title: 'A' } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await searchPageByPrefix.handle( { prefix: 'A' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'surfaces errors as isError results via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( searchPageByPrefix, ctx )( { prefix: 'A' } );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
