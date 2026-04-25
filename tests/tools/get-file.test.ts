import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { formatPayload } from '../../src/common/formatPayload.js';

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

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			title: 'File:Example.png',
			descriptionUrl: 'https://test.wiki/wiki/File:Example.png',
			timestamp: '2026-01-01T00:00:00Z',
			user: 'Admin',
			size: 12345,
			mime: 'image/png',
			url: 'https://test.wiki/images/example.png',
			thumbnailUrl: 'https://test.wiki/images/thumb/example.png/200px-example.png'
		} ) );
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

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns error on API failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetFileTool } = await import( '../../src/tools/get-file.js' );
		const result = await handleGetFileTool( 'Example.png' );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
