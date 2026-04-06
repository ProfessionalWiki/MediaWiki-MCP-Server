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

describe( 'get-file', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'returns file info using action=query&prop=imageinfo', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						title: 'File:Example.png',
						imageinfo: [ {
							url: 'https://test.wiki/images/example.png',
							descriptionurl: 'https://test.wiki/wiki/File:Example.png',
							size: 12345,
							width: 800,
							height: 600,
							mime: 'image/png',
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							thumburl: 'https://test.wiki/images/thumb/example.png/200px-example.png'
						} ]
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetFileTool } = await import( '../../src/tools/get-file.js' );
		const result = await handleGetFileTool( 'Example.png' );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'File title: File:Example.png' );
		expect( result.content[ 0 ].text ).toContain( 'https://test.wiki/images/example.png' );
		expect( result.content[ 0 ].text ).toContain( 'Timestamp: 2026-01-01T00:00:00Z' );
		expect( result.content[ 0 ].text ).toContain( 'User: Admin' );
		expect( result.content[ 0 ].text ).toContain( 'Thumbnail URL:' );
	} );

	it( 'handles missing files', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						title: 'File:Missing.png',
						missing: true
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetFileTool } = await import( '../../src/tools/get-file.js' );
		const result = await handleGetFileTool( 'Missing.png' );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'not found' );
	} );

	it( 'returns error on API failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetFileTool } = await import( '../../src/tools/get-file.js' );
		const result = await handleGetFileTool( 'Example.png' );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'API error' );
	} );
} );
