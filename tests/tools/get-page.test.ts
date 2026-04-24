import { describe, it, expect, vi, beforeEach } from 'vitest';
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( 'Hello world' );
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( '<p>Hello</p>' );
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
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Page ID: 1' );
		expect( result.content[ 0 ].text ).toContain( 'Title: Test Page' );
		expect( result.content[ 0 ].text ).not.toContain( 'License' );
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

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'not found' );
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
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', true );

		expect( result.isError ).toBeUndefined();
		expect( result.content.length ).toBe( 2 );
		expect( result.content[ 0 ].text ).toContain( 'Page ID: 1' );
		expect( result.content[ 1 ].text ).toBe( 'Source:\nHello world' );
	} );

	it( 'returns error on mwn failure', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'source', false );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'API error' );
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( 'Section body' );
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( '<p>Section HTML</p>' );
		expect( request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'parse',
			page: 'Test Page',
			section: 1
		} ) );
	} );

	it( 'rejects section with content="none"', async () => {
		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'none', true, 2 );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'section is not compatible with content="none"' );
	} );

	it( 'reports the full-page Size in metadata even when section is set (size is revision-level, not section-level)', async () => {
		// When rvsection=N is combined with rvprop=...|size, MediaWiki returns
		// the section-scoped content but the whole-revision size. That is the
		// correct semantic for a "Size:" metadata field ("how big is this page")
		// and this test pins it against regression.
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Size: 98765' );
		expect( read ).toHaveBeenCalledWith( 'Test Page', expect.objectContaining( {
			rvsection: 1
		} ) );
	} );

	it( 'omits Size from metadata when the revision has no size field', async () => {
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).not.toContain( 'Size:' );
	} );

	it( 'metadata=true includes Size and Sections block (section 0 labeled Lead)', async () => {
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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Size: 12345' );
		expect( result.content[ 0 ].text ).toContain( 'Sections:\n- 0: Lead\n- 1: History\n- 2: Background' );
	} );

	it( 'truncates source content over 50000 bytes with a content-truncated marker', async () => {
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

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 2 );
		expect( result.content[ 0 ].text ).toHaveLength( 50000 );
		expect( result.content[ 1 ].text ).toContain( 'Content truncated at 50000 of 50001 bytes' );
		expect( result.content[ 1 ].text ).toContain( 'Available sections: 0 (Lead), 1 (History)' );
		expect( result.content[ 1 ].text ).toContain( 'call get-page again with section=N' );
	} );

	it( 'does not truncate source content at exactly 50000 bytes', async () => {
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

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( result.content[ 0 ].text ).toHaveLength( 50000 );
	} );

	it( 'truncates HTML content over 50000 bytes with a content-truncated marker', async () => {
		const bigHtml = '<p>' + 'x'.repeat( 60000 ) + '</p>';
		const request = vi.fn()
			.mockResolvedValueOnce( { parse: { text: bigHtml } } )
			.mockResolvedValueOnce( { parse: { sections: [ { line: 'Heading' } ] } } );
		const mock = createMockMwn( { request } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Huge', 'html', false );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 2 );
		expect( result.content[ 0 ].text ).toHaveLength( 50000 );
		expect( result.content[ 1 ].text ).toContain( 'Content truncated at 50000 of ' );
		expect( result.content[ 1 ].text ).toContain( 'Available sections: 0 (Lead), 1 (Heading)' );
	} );

	it( 'html+metadata does not duplicate metadata or read call', async () => {
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
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetPageTool } = await import( '../../src/tools/get-page.js' );
		const result = await handleGetPageTool( 'Test Page', 'html', true );

		expect( result.isError ).toBeUndefined();
		expect( mock.read ).toHaveBeenCalledTimes( 1 );
		expect( result.content.length ).toBe( 2 );
		expect( result.content[ 0 ].text ).toContain( 'Page ID: 1' );
		expect( result.content[ 1 ].text ).toBe( 'HTML:\n<p>Hello</p>' );
	} );
} );
