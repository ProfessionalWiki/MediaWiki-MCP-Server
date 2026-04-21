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
import { wikiService } from '../../src/common/wikiService.js';

describe( 'update-page', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'calls mwn.save() with baserevid for conflict detection', async () => {
		const mock = createMockMwn( {
			save: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 5, title: 'My Page',
				contentmodel: 'wikitext', oldrevid: 41, newrevid: 42,
				newtimestamp: '2026-01-02T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( 'My Page', 'Updated content', 41, 'edit summary' );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Page updated successfully' );
		expect( mock.save ).toHaveBeenCalledWith(
			'My Page', 'Updated content',
			expect.stringContaining( 'edit summary' ),
			expect.objectContaining( { baserevid: 41, nocreate: true } )
		);
	} );

	it( 'calls mwn.save() without baserevid when latestId is omitted', async () => {
		const mock = createMockMwn( {
			save: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 5, title: 'My Page',
				contentmodel: 'wikitext', oldrevid: 41, newrevid: 42,
				newtimestamp: '2026-01-02T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( 'My Page', 'Updated content', undefined, 'edit summary' );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Page updated successfully' );
		expect( mock.save ).toHaveBeenCalledWith(
			'My Page', 'Updated content',
			expect.stringContaining( 'edit summary' ),
			expect.objectContaining( { nocreate: true } )
		);
		const options = mock.save.mock.calls[ 0 ][ 3 ];
		expect( options ).not.toHaveProperty( 'baserevid' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			save: vi.fn().mockRejectedValue( new Error( 'Edit conflict' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( 'My Page', 'content', 41 );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'Edit conflict' );
	} );

	it( 'surfaces the missingtitle error from mwn when page does not exist', async () => {
		const mock = createMockMwn( {
			save: vi.fn().mockRejectedValue( new Error( 'The page you specified doesn\'t exist.' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( 'Does Not Exist', 'content', 1 );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'doesn\'t exist' );
	} );

	it( 'forwards configured array tags to mwn.save()', async () => {
		vi.mocked( wikiService.getCurrent ).mockReturnValueOnce( {
			key: 'test-wiki',
			config: {
				server: 'https://test.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				tags: [ 'mcp-server', 'automated' ]
			}
		} as ReturnType<typeof wikiService.getCurrent> );

		const mock = createMockMwn( {
			save: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 7, title: 'Tagged Page',
				contentmodel: 'wikitext', oldrevid: 50, newrevid: 51,
				newtimestamp: '2026-01-02T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		await handleUpdatePageTool( 'Tagged Page', 'content', 50, 'summary' );

		const opts = mock.save.mock.calls[ 0 ][ 3 ];
		expect( opts ).toHaveProperty( 'tags', [ 'mcp-server', 'automated' ] );
	} );

	it( 'omits tags from save options when not configured', async () => {
		const mock = createMockMwn( {
			save: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 8, title: 'Untagged',
				contentmodel: 'wikitext', oldrevid: 60, newrevid: 61,
				newtimestamp: '2026-01-02T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		await handleUpdatePageTool( 'Untagged', 'content', undefined, 'summary' );

		const opts = mock.save.mock.calls[ 0 ][ 3 ];
		expect( opts ).not.toHaveProperty( 'tags' );
	} );

	it( 'treats null tags as unset on save', async () => {
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
			save: vi.fn().mockResolvedValue( {
				result: 'Success', pageid: 9, title: 'Null Tagged',
				contentmodel: 'wikitext', oldrevid: 70, newrevid: 71,
				newtimestamp: '2026-01-02T00:00:00Z'
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		await handleUpdatePageTool( 'Null Tagged', 'content', undefined, 'summary' );

		const opts = mock.save.mock.calls[ 0 ][ 3 ];
		expect( opts ).not.toHaveProperty( 'tags' );
	} );
} );
