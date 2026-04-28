import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getPageHistory } from '../../src/tools/get-page-history.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'get-page-history', () => {
	it( 'returns basic revision history', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						revisions: [ {
							revid: 100,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'edit',
							size: 500,
							minor: false
						} ]
					} ]
				}
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Revision ID: 100' );
		expect( text ).toContain( 'Timestamp: 2026-01-01T00:00:00Z' );
		expect( text ).toContain( 'User: Admin' );
		expect( text ).toContain( 'Userid: 1' );
		expect( text ).toContain( 'Comment: edit' );
		expect( text ).toContain( 'Size: 500' );
		expect( text ).toContain( 'Minor: false' );
	} );

	it( 'maps olderThan to rvstartid (default rvdir=older) and skips boundary revision', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 100, timestamp: '2026-01-01T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 100, minor: false },
					{ revid: 99, timestamp: '2025-12-31T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 90, minor: false }
				] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page', olderThan: 100 }, ctx );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( { rvstartid: 100 } );
		expect( call.rvdir ).toBeUndefined();
		expect( call.rvendid ).toBeUndefined();

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Revision ID: 99' );
		expect( text ).not.toContain( 'Revision ID: 100' );
	} );

	it( 'maps newerThan to rvstartid with rvdir=newer', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [ { revid: 50, timestamp: '2026-01-01T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 100, minor: false }, { revid: 101, timestamp: '2026-01-02T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 200, minor: false } ] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page', newerThan: 50 }, ctx );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvstartid: 50, rvdir: 'newer' } )
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Revision ID: 101' );
		expect( text ).not.toContain( 'Revision ID: 50' );
	} );

	it( 'maps filter to rvtag', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [ { revid: 100, timestamp: '2026-01-01T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 100, minor: false } ] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await getPageHistory.handle( { title: 'Test Page', filter: 'mw-reverted' }, ctx );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvtag: 'mw-reverted' } )
		);
	} );

	it( 'returns isError when the page does not exist', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { missing: true, title: 'Nonexistent' } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Nonexistent' }, ctx );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns an empty revisions array when the API returns none', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Revisions: (none)' );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'returns full segment of 20 revisions when boundary filters one out', async () => {
		const revisions = Array.from( { length: 21 }, ( _, i ) => ( {
			revid: 100 - i,
			timestamp: `2026-01-01T${ String( 20 - i ).padStart( 2, '0' ) }:00:00Z`,
			user: 'Admin',
			userid: 1,
			comment: '',
			size: 100,
			minor: false
		} ) );
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page', olderThan: 100 }, ctx );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvlimit: 21, rvstartid: 100 } )
		);
		const text = assertStructuredSuccess( result );
		const revIds = ( text.match( /Revision ID: \d+/g ) ?? [] );
		expect( revIds ).toHaveLength( 20 );
		expect( text ).toContain( 'Revision ID: 99' );
		expect( text ).toContain( 'Revision ID: 80' );
		expect( text ).not.toContain( 'Revision ID: 100' );
	} );

	it( 'caps result at 20 when boundary revision is not in the returned window', async () => {
		const revisions = Array.from( { length: 21 }, ( _, i ) => ( {
			revid: 200 - i,
			timestamp: `2026-01-01T${ String( 20 - i ).padStart( 2, '0' ) }:00:00Z`,
			user: 'Admin',
			userid: 1,
			comment: '',
			size: 100,
			minor: false
		} ) );
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page', olderThan: 999 }, ctx );

		const text = assertStructuredSuccess( result );
		const revIds = ( text.match( /Revision ID: \d+/g ) ?? [] );
		expect( revIds ).toHaveLength( 20 );
	} );

	it( 'uses rvlimit 20 when no boundary is provided', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [ {
					revid: 1, timestamp: '2026-01-01T00:00:00Z', user: 'Admin',
					userid: 1, comment: '', size: 0, minor: false
				} ] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await getPageHistory.handle( { title: 'Test Page' }, ctx );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvlimit: 20 } )
		);
	} );

	it( 'returns error on failure via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( getPageHistory, ctx )( { title: 'Test Page' } );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );

	it( 'attaches a more-available truncation with olderThan when more revisions exist', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 100, timestamp: '2026-01-02T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false },
					{ revid: 99, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] },
				continue: { rvcontinue: '20260101000000|98', continue: '||' }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: more-available' );
		expect( text ).toContain( '  Returned count: 2' );
		expect( text ).toContain( '  Item noun: revisions' );
		expect( text ).toContain( '  Tool name: get-page-history' );
		expect( text ).toContain( '  Continue with:' );
		expect( text ).toContain( '    Param: olderThan' );
		expect( text ).toContain( '    Value: 99' );
	} );

	it( 'attaches a more-available truncation with newerThan when walking forward', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 50, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false },
					{ revid: 60, timestamp: '2026-01-02T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] },
				continue: { rvcontinue: '20260103000000|70', continue: '||' }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page', newerThan: 49 }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: more-available' );
		expect( text ).toContain( '  Returned count: 2' );
		expect( text ).toContain( '  Item noun: revisions' );
		expect( text ).toContain( '  Tool name: get-page-history' );
		expect( text ).toContain( '  Continue with:' );
		expect( text ).toContain( '    Param: newerThan' );
		expect( text ).toContain( '    Value: 60' );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call.rvdir ).toBe( 'newer' );
	} );

	it( 'omits truncation when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 100, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPageHistory.handle( { title: 'Test Page' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Truncation:' );
	} );
} );
