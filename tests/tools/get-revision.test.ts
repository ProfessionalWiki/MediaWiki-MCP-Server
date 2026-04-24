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

const GetRevisionOutputSchema = z.object( {
	revisionId: z.number().int().nonnegative().optional(),
	pageId: z.number().int().nonnegative().optional(),
	title: z.string().optional(),
	url: z.string().optional(),
	userid: z.number().int().nonnegative().optional(),
	user: z.string().optional(),
	timestamp: z.string().optional(),
	comment: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	minor: z.boolean().optional(),
	contentModel: z.string().optional(),
	source: z.string().optional(),
	html: z.string().optional()
} );

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

		const data = assertStructuredSuccess( result, GetRevisionOutputSchema );
		expect( data.source ).toBe( 'Hello world' );
		expect( data.revisionId ).toBe( 42 );
		expect( data.title ).toBe( 'Test Page' );
		expect( data.user ).toBeUndefined();
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

		const data = assertStructuredSuccess( result, GetRevisionOutputSchema );
		expect( data.html ).toBe( '<p>Hello</p>' );
		expect( data.revisionId ).toBe( 42 );
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

		const data = assertStructuredSuccess( result, GetRevisionOutputSchema );
		expect( data.minor ).toBe( true );
		expect( data.url ).toContain( 'Test_Page' );
		expect( data.source ).toBeUndefined();
		expect( data.html ).toBeUndefined();
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

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'not found' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'source', false );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );
} );
