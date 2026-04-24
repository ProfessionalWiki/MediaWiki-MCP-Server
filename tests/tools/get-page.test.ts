import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { TruncationSchema } from '../../src/common/schemas.js';

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn()
} ) );

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

const GetPageSchema = z.object( {
	pageId: z.number().int().nonnegative().optional(),
	title: z.string().optional(),
	latestRevisionId: z.number().int().nonnegative().optional(),
	latestRevisionTimestamp: z.string().optional(),
	contentModel: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	url: z.string().optional(),
	sections: z.array( z.string() ).optional(),
	source: z.string().optional(),
	html: z.string().optional(),
	truncation: TruncationSchema.optional()
} );

describe( 'get-page', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns page source using mwn.read()', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: 'Hello world'
				} ]
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', false );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.source ).toBe( 'Hello world' );
		expect( data.pageId ).toBeUndefined();
		expect( data.title ).toBeUndefined();
		expect( mock.read ).toHaveBeenCalledWith( 'Test Page', expect.any( Object ) );
	} );

	it( 'returns HTML using action=parse', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'html', false );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.html ).toBe( '<p>Hello</p>' );
	} );

	it( 'returns metadata without content for ContentFormat.none', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.pageId ).toBe( 1 );
		expect( data.title ).toBe( 'Test Page' );
		expect( data.latestRevisionId ).toBe( 42 );
		expect( data.contentModel ).toBe( 'wikitext' );
		expect( data.source ).toBeUndefined();
		expect( data.html ).toBeUndefined();
	} );

	it( 'returns error when page is missing', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 0,
				title: 'Missing Page',
				missing: true
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Missing Page', 'source', false );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'not found' );
	} );

	it( 'returns both metadata and source when both requested', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: 'Hello world'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', true );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.pageId ).toBe( 1 );
		expect( data.source ).toBe( 'Hello world' );
	} );

	it( 'returns error on mwn failure', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', false );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'API error' );
	} );

	it( 'forwards section as rvsection for source content', async () => {
		const read = vi.fn().mockResolvedValue( {
			pageid: 1,
			title: 'Test Page',
			revisions: [ {
				revid: 42,
				timestamp: '2026-01-01T00:00:00Z',
				contentmodel: 'wikitext',
				content: 'Section body'
			} ]
		} );
		const mock = createMockMwn( { read } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', false, 2 );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.source ).toBe( 'Section body' );
		expect( read ).toHaveBeenCalledWith( 'Test Page', expect.objectContaining( {
			rvsection: 2
		} ) );
	} );

	it( 'forwards section as parse section for html content', async () => {
		const request = vi.fn().mockResolvedValue( {
			parse: { text: '<p>Section HTML</p>' }
		} );
		const mock = createMockMwn( { request } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'html', false, 1 );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.html ).toBe( '<p>Section HTML</p>' );
		expect( request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'parse',
			page: 'Test Page',
			section: 1
		} ) );
	} );

	it( 'rejects section with content="none"', async () => {
		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true, 2 );

		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain( 'section is not compatible with content="none"' );
	} );

	it( 'reports the full-page size in metadata even when section is set', async () => {
		const read = vi.fn().mockResolvedValue( {
			pageid: 1,
			title: 'Test Page',
			revisions: [ {
				revid: 42,
				timestamp: '2026-01-01T00:00:00Z',
				contentmodel: 'wikitext',
				size: 98765,
				content: 'Section body'
			} ]
		} );
		const request = vi.fn().mockResolvedValue( {
			parse: { sections: [ { line: 'History' } ] }
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { read, request } ) as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', true, 1 );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.size ).toBe( 98765 );
		expect( read ).toHaveBeenCalledWith( 'Test Page', expect.objectContaining( {
			rvsection: 1
		} ) );
	} );

	it( 'omits size from metadata when the revision has no size field', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'No Size',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'No Size', 'none', true );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.size ).toBeUndefined();
	} );

	it( 'metadata=true includes size and sections array (lead slot is empty string)', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					size: 12345
				} ]
			} ),
			request: vi.fn().mockResolvedValue( {
				parse: {
					sections: [
						{ line: 'History', number: '1', index: '1' },
						{ line: 'Background', number: '2', index: '2' }
					]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.size ).toBe( 12345 );
		expect( data.sections ).toEqual( [ '', 'History', 'Background' ] );
	} );

	it( 'attaches content-truncated truncation when source exceeds the byte cap', async () => {
		const big = 'x'.repeat( 50001 );
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Big',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: big
				} ]
			} ),
			request: vi.fn().mockResolvedValue( {
				parse: { sections: [ { line: 'History' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Big', 'source', false );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.source ).toHaveLength( 50000 );
		expect( data.truncation ).toMatchObject( {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 50001,
			itemNoun: 'wikitext',
			toolName: 'get-page',
			sections: [ '', 'History' ]
		} );
	} );

	it( 'omits truncation when source is exactly at the byte cap', async () => {
		const exact = 'y'.repeat( 50000 );
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Exact',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: exact
				} ]
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Exact', 'source', false );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.source ).toHaveLength( 50000 );
		expect( data.truncation ).toBeUndefined();
	} );

	it( 'attaches content-truncated truncation when HTML exceeds the byte cap', async () => {
		const bigHtml = '<p>' + 'x'.repeat( 60000 ) + '</p>';
		const request = vi.fn()
			.mockResolvedValueOnce( { parse: { text: bigHtml } } )
			.mockResolvedValueOnce( { parse: { sections: [ { line: 'Heading' } ] } } );
		const mock = createMockMwn( { request } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Huge', 'html', false );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( data.html ).toHaveLength( 50000 );
		expect( data.truncation ).toMatchObject( {
			reason: 'content-truncated',
			returnedBytes: 50000,
			itemNoun: 'HTML',
			toolName: 'get-page',
			sections: [ '', 'Heading' ]
		} );
	} );

	it( 'html+metadata calls read once and returns both metadata and html', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn()
				.mockResolvedValueOnce( { parse: { sections: [] } } )
				.mockResolvedValueOnce( { parse: { text: '<p>Hello</p>' } } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'html', true );

		const data = assertStructuredSuccess( result, GetPageSchema );
		expect( mock.read ).toHaveBeenCalledTimes( 1 );
		expect( data.pageId ).toBe( 1 );
		expect( data.html ).toBe( '<p>Hello</p>' );
	} );
} );
