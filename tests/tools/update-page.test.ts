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

function successResponse( overrides: Record<string, unknown> = {} ) {
	return {
		edit: {
			result: 'Success',
			pageid: 5,
			title: 'My Page',
			contentmodel: 'wikitext',
			oldrevid: 41,
			newrevid: 42,
			newtimestamp: '2026-01-02T00:00:00Z',
			...overrides
		}
	};
}

function mockEdit( response: unknown = successResponse() ) {
	return createMockMwn( {
		request: vi.fn().mockResolvedValue( response ),
		getCsrfToken: vi.fn().mockResolvedValue( 'csrf-token' )
	} );
}

describe( 'update-page', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	describe( 'full-page replacement', () => {
		it( 'sends text=source with nocreate and baserevid for conflict detection', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'Updated content', latestId: 41, comment: 'edit summary'
			} );

			expect( result.isError ).toBeUndefined();
			expect( result.content[ 0 ].text ).toContain( 'Page updated successfully' );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( {
				action: 'edit',
				title: 'My Page',
				text: 'Updated content',
				nocreate: true,
				baserevid: 41,
				token: 'csrf-token'
			} );
			expect( params.summary ).toContain( 'edit summary' );
		} );

		it( 'omits baserevid when latestId is not supplied', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( { title: 'My Page', source: 'content' } );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).not.toHaveProperty( 'baserevid' );
		} );

		it( 'returns error when the API response lacks a Success result', async () => {
			const mock = mockEdit( { edit: { result: 'Failure', code: 'abusefilter-disallowed' } } );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'My Page', source: 'content' } );

			expect( result.isError ).toBe( true );
			expect( result.content[ 0 ].text ).toContain( 'Failed to update page' );
		} );

		it( 'returns error when mwn.request throws', async () => {
			const mock = mockEdit();
			mock.request = vi.fn().mockRejectedValue( new Error( 'Edit conflict' ) );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'My Page', source: 'content', latestId: 41 } );

			expect( result.isError ).toBe( true );
			expect( result.content[ 0 ].text ).toContain( 'Edit conflict' );
		} );

		it( 'surfaces the missingtitle error from mwn when page does not exist', async () => {
			const mock = mockEdit();
			mock.request = vi.fn().mockRejectedValue( new Error( "The page you specified doesn't exist." ) );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'Does Not Exist', source: 'content', latestId: 1 } );

			expect( result.isError ).toBe( true );
			expect( result.content[ 0 ].text ).toContain( "doesn't exist" );
		} );
	} );

	describe( 'tags', () => {
		it( 'forwards configured array tags', async () => {
			vi.mocked( wikiService.getCurrent ).mockReturnValueOnce( {
				key: 'test-wiki',
				config: {
					server: 'https://test.wiki',
					articlepath: '/wiki',
					scriptpath: '/w',
					tags: [ 'mcp-server', 'automated' ]
				}
			} as ReturnType<typeof wikiService.getCurrent> );
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( { title: 'Tagged', source: 'content' } );

			expect( mock.request.mock.calls[ 0 ][ 0 ] ).toHaveProperty( 'tags', [ 'mcp-server', 'automated' ] );
		} );

		it( 'omits tags when not configured', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( { title: 'Untagged', source: 'content' } );

			expect( mock.request.mock.calls[ 0 ][ 0 ] ).not.toHaveProperty( 'tags' );
		} );
	} );
} );
