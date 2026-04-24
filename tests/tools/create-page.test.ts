import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { PageMetadataSchema } from '../../src/common/schemas.js';

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
import { wikiService } from '../../src/common/wikiService.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'create-page', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'calls mwn.create() with correct params', async () => {
		const mock = createMockMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 10, title: 'New Page',
				contentmodel: 'wikitext', oldrevid: 0, newrevid: 1,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		const result = await handleCreatePageTool( 'Hello', 'New Page', 'test', 'wikitext' );

		const data = assertStructuredSuccess( result, PageMetadataSchema );
		expect( data ).toEqual( {
			pageId: 10,
			title: 'New Page',
			latestRevisionId: 1,
			latestRevisionTimestamp: '2026-01-01T00:00:00Z',
			contentModel: 'wikitext',
			url: 'https://test.wiki/wiki/New_Page'
		} );
		expect( mock.create ).toHaveBeenCalledWith(
			'New Page', 'Hello',
			expect.stringContaining( 'test' ),
			expect.objectContaining( { contentmodel: 'wikitext' } )
		);
	} );

	it( 'omits contentmodel when not provided, letting MediaWiki auto-detect by namespace', async () => {
		const mock = createMockMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 11, title: 'Module:Foo',
				contentmodel: 'Scribunto', oldrevid: 0, newrevid: 2,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		await handleCreatePageTool( '-- lua', 'Module:Foo', undefined, undefined );

		const opts = mock.create.mock.calls[ 0 ][ 3 ];
		expect( opts ).not.toHaveProperty( 'contentmodel' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			create: vi.fn().mockRejectedValue( new Error( 'Page exists' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		const result = await handleCreatePageTool( 'Hello', 'Existing Page', undefined, 'wikitext' );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'Page exists' );
	} );

	it( 'forwards configured tags to mwn.create()', async () => {
		vi.mocked( wikiService.getCurrent ).mockReturnValueOnce( {
			key: 'test-wiki',
			config: {
				server: 'https://test.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				tags: 'mcp-server'
			}
		} as ReturnType<typeof wikiService.getCurrent> );

		const mock = createMockMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 12, title: 'Tagged Page',
				contentmodel: 'wikitext', oldrevid: 0, newrevid: 3,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		await handleCreatePageTool( 'Hello', 'Tagged Page', undefined, undefined );

		const opts = mock.create.mock.calls[ 0 ][ 3 ];
		expect( opts ).toHaveProperty( 'tags', 'mcp-server' );
	} );

	it( 'omits tags from options when not configured', async () => {
		const mock = createMockMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 13, title: 'Untagged Page',
				contentmodel: 'wikitext', oldrevid: 0, newrevid: 4,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		await handleCreatePageTool( 'Hello', 'Untagged Page', undefined, undefined );

		const opts = mock.create.mock.calls[ 0 ][ 3 ];
		expect( opts ).not.toHaveProperty( 'tags' );
	} );

	it( 'treats null tags as unset', async () => {
		vi.mocked( wikiService.getCurrent ).mockReturnValueOnce( {
			key: 'test-wiki',
			config: {
				server: 'https://test.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				tags: null
			}
		} as ReturnType<typeof wikiService.getCurrent> );

		const mock = createMockMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 14, title: 'Null Tagged Page',
				contentmodel: 'wikitext', oldrevid: 0, newrevid: 5,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		await handleCreatePageTool( 'Hello', 'Null Tagged Page', undefined, undefined );

		const opts = mock.create.mock.calls[ 0 ][ 3 ];
		expect( opts ).not.toHaveProperty( 'tags' );
	} );
} );
