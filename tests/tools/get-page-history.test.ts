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

	it( 'maps olderThan to rvendid and skips boundary revision', async () => {
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

		expect( mock.request ).toHaveBeenCalledWith(
			expect.objectContaining( { rvendid: 100 } )
		);
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

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageHistoryTool } = await import( '../../src/tools/get-page-history.js' );
		const result = await handleGetPageHistoryTool( 'Test Page' );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'API error' );
	} );
} );
