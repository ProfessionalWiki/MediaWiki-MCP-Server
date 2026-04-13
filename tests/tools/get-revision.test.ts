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

describe( 'get-revision', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'returns source content from a specific revision', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Test Page',
						revisions: [ {
							revid: 42,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'edit',
							size: 500,
							minor: false,
							content: 'Hello world'
						} ]
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'source', false );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( 'Hello world' );
	} );

	it( 'returns HTML content using action=parse', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'html', false );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( '<p>Hello</p>' );
	} );

	it( 'returns metadata with minor edit flag', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Test Page',
						revisions: [ {
							revid: 42,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'minor fix',
							size: 500,
							minor: true
						} ]
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'none', true );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Minor: true' );
		expect( result.content[ 0 ].text ).toContain( 'HTML URL:' );
		expect( result.content[ 0 ].text ).not.toContain( 'Delta' );
	} );

	it( 'returns error when revision is not found', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 0,
						title: '',
						missing: true
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 99999, 'source', false );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'not found' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'source', false );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'API error' );
	} );
} );
