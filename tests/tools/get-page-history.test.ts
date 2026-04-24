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

describe( 'get-page-history', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Revision ID: 100' );
		expect( result.content[ 0 ].text ).toContain( 'User: Admin (ID: 1)' );
		expect( result.content[ 0 ].text ).not.toContain( 'Delta' );
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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page', 100 );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( { rvstartid: 100 } );
		expect( call.rvdir ).toBeUndefined();
		expect( call.rvendid ).toBeUndefined();
		// Should skip the boundary revision (100)
		expect( result.content.length ).toBe( 1 );
		expect( result.content[ 0 ].text ).toContain( 'Revision ID: 99' );
	} );

	it( 'maps newerThan to rvstartid with rvdir=newer', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [ { revid: 50, timestamp: '2026-01-01T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 100, minor: false }, { revid: 101, timestamp: '2026-01-02T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 200, minor: false } ] } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page', undefined, 50 );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvstartid: 50, rvdir: 'newer' } )
		);
		// Should skip the boundary revision (50)
		expect( result.content.length ).toBe( 1 );
		expect( result.content[ 0 ].text ).toContain( 'Revision ID: 101' );
	} );

	it( 'maps filter to rvtag', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [ { revid: 100, timestamp: '2026-01-01T00:00:00Z', user: 'Admin', userid: 1, comment: '', size: 100, minor: false } ] } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		await handleGetPageHistoryTool( 'Test Page', undefined, undefined, 'mw-reverted' );

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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Nonexistent' );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'not found' );
	} );

	it( 'handles empty results', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [] } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		expect( result.content[ 0 ].text ).toContain( 'No revisions found' );
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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page', 100 );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvlimit: 21, rvstartid: 100 } )
		);
		expect( result.content.length ).toBe( 20 );
		expect( result.content[ 0 ].text ).toContain( 'Revision ID: 99' );
		expect( result.content[ 19 ].text ).toContain( 'Revision ID: 80' );
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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page', 999 );

		expect( result.content.length ).toBe( 20 );
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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		await handleGetPageHistoryTool( 'Test Page' );

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvlimit: 20 } )
		);
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );

	it( 'appends a more-available marker with olderThan when more revisions exist', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 100, timestamp: '2026-01-02T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false },
					{ revid: 99, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] },
				continue: { rvcontinue: '20260101000000|98', continue: '||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toBe(
			'More results available. Returned 2 revisions. To fetch the next segment, call get-page-history again with olderThan=99.'
		);
	} );

	it( 'appends a more-available marker with newerThan when walking forward', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 50, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false },
					{ revid: 60, timestamp: '2026-01-02T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] },
				continue: { rvcontinue: '20260103000000|70', continue: '||' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page', undefined, 49 );

		const last = result.content[ result.content.length - 1 ] as { text: string };
		expect( last.text ).toBe(
			'More results available. Returned 2 revisions. To fetch the next segment, call get-page-history again with newerThan=60.'
		);

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call.rvdir ).toBe( 'newer' );
	} );

	it( 'does not append a marker when response.continue is absent', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { revisions: [
					{ revid: 100, timestamp: '2026-01-01T00:00:00Z', user: 'A', userid: 1, comment: '', size: 1, minor: false }
				] } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		for ( const block of result.content ) {
			expect( ( block as { text: string } ).text ).not.toContain( 'More results available' );
		}
	} );
} );
