import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';

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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Source: Hello world' );
		expect( text ).not.toContain( 'Page ID:' );
		expect( text ).not.toContain( 'Title:' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Title: Test Page' );
		expect( text ).toContain( 'Latest revision ID: 42' );
		expect( text ).toContain( 'Content model: wikitext' );
		expect( text ).not.toContain( 'Source:' );
		expect( text ).not.toContain( 'HTML:' );
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

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Source: Hello world' );
	} );

	it( 'returns error on mwn failure', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', false );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Source: Section body' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'HTML: <p>Section HTML</p>' );
		expect( request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'parse',
			page: 'Test Page',
			section: 1
		} ) );
	} );

	it( 'rejects section with content="none"', async () => {
		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true, 2 );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toContain( 'section is not compatible with content="none"' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Size: 98765' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).not.toContain( 'Size:' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Size: 12345' );
		expect( text ).toContain( 'Sections:\n- (empty)\n- History\n- Background' );
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

		const text = assertStructuredSuccess( result, z.string() );
		// Source body is ~50000 chars, rendered as long-string block after Source: label.
		expect( text ).toMatch( /Source:\n\nx{50000}/ );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Total bytes: 50001' );
		expect( text ).toContain( '  Item noun: wikitext' );
		expect( text ).toContain( '  Tool name: get-page' );
		expect( text ).toContain( '  Sections:\n  - (empty)\n  - History' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toMatch( /Source:\n\ny{50000}/ );
		expect( text ).not.toContain( 'Truncation:' );
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

		const text = assertStructuredSuccess( result, z.string() );
		// Truncated HTML is rendered as long-string block.
		expect( text ).toMatch( /HTML:\n\n<p>x+/ );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Item noun: HTML' );
		expect( text ).toContain( '  Tool name: get-page' );
		expect( text ).toContain( '  Sections:\n  - (empty)\n  - Heading' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( mock.read ).toHaveBeenCalledTimes( 1 );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
	} );
} );
