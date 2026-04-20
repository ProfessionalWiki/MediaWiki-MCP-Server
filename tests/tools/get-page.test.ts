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
