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
import { wikiService } from '../../src/common/wikiService.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

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

			const text = assertStructuredSuccess( result );
			expect( text ).toBe( formatPayload( {
				pageId: 5,
				title: 'My Page',
				latestRevisionId: 42,
				latestRevisionTimestamp: '2026-01-02T00:00:00Z',
				contentModel: 'wikitext',
				url: 'https://test.wiki/wiki/My_Page'
			} ) );

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

			const envelope = assertStructuredError( result, 'upstream_failure' );
			expect( envelope.message ).toContain( 'Failed to update page' );
		} );

		it( 'returns error when mwn.request throws', async () => {
			const mock = mockEdit();
			mock.request = vi.fn().mockRejectedValue( new Error( 'Edit conflict' ) );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'My Page', source: 'content', latestId: 41 } );

			const envelope = assertStructuredError( result, 'upstream_failure' );
			expect( envelope.message ).toContain( 'Edit conflict' );
		} );

		it( 'surfaces the missingtitle error from mwn when page does not exist', async () => {
			const mock = mockEdit();
			mock.request = vi.fn().mockRejectedValue( new Error( "The page you specified doesn't exist." ) );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'Does Not Exist', source: 'content', latestId: 1 } );

			const envelope = assertStructuredError( result, 'upstream_failure' );
			expect( envelope.message ).toContain( "doesn't exist" );
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

	describe( 'section editing', () => {
		it( 'forwards section=2 as section=\'2\' with text=source', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'new section body', section: 2
			} );

			expect( result.isError ).toBeUndefined();
			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( { section: '2', text: 'new section body' } );
		} );

		it( 'forwards section=0 (lead) as section=\'0\'', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( { title: 'My Page', source: 'lead', section: 0 } );

			expect( mock.request.mock.calls[ 0 ][ 0 ] ).toMatchObject( { section: '0' } );
		} );

		it( 'maps nosuchsection error to a friendly message', async () => {
			const mock = mockEdit();
			mock.request = vi.fn().mockRejectedValue( new Error( 'nosuchsection: There is no section 99.' ) );
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( { title: 'My Page', source: 'x', section: 99 } );

			const envelope = assertStructuredError( result, 'not_found' );
			expect( envelope.message ).toBe( 'Section 99 does not exist' );
		} );

		it( 'forwards section=\'new\' with sectionTitle as sectiontitle', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( {
				title: 'My Page', source: 'body', section: 'new', sectionTitle: 'History'
			} );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( {
				section: 'new',
				sectiontitle: 'History',
				text: 'body'
			} );
		} );

		it( 'rejects section=\'new\' without sectionTitle', async () => {
			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'body', section: 'new'
			} );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'sectionTitle is required when section=\'new\'' );
		} );

		it( 'rejects sectionTitle when section is a number', async () => {
			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'body', section: 2, sectionTitle: 'History'
			} );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'sectionTitle is only valid when section=\'new\'' );
		} );

		it( 'rejects sectionTitle when section is undefined', async () => {
			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'body', sectionTitle: 'History'
			} );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'sectionTitle is only valid when section=\'new\'' );
		} );
	} );

	describe( 'append/prepend mode', () => {
		it( 'mode=append sends appendtext=source and omits text', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( {
				title: 'My Page', source: '\n* New entry', mode: 'append'
			} );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( { appendtext: '\n* New entry' } );
			expect( params ).not.toHaveProperty( 'text' );
			expect( params ).not.toHaveProperty( 'prependtext' );
		} );

		it( 'mode=prepend sends prependtext=source and omits text', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( {
				title: 'My Page', source: 'intro\n', mode: 'prepend'
			} );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( { prependtext: 'intro\n' } );
			expect( params ).not.toHaveProperty( 'text' );
			expect( params ).not.toHaveProperty( 'appendtext' );
		} );

		it( 'mode=append composes with section=2', async () => {
			const mock = mockEdit();
			vi.mocked( getMwn ).mockResolvedValue( mock as any );

			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			await handleUpdatePageTool( {
				title: 'My Page', source: '\n* row', section: 2, mode: 'append'
			} );

			const params = mock.request.mock.calls[ 0 ][ 0 ];
			expect( params ).toMatchObject( { section: '2', appendtext: '\n* row' } );
			expect( params ).not.toHaveProperty( 'text' );
		} );

		it( 'rejects mode combined with section=\'new\'', async () => {
			const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
			const result = await handleUpdatePageTool( {
				title: 'My Page', source: 'body', section: 'new', sectionTitle: 'History', mode: 'append'
			} );

			const envelope = assertStructuredError( result, 'invalid_input' );
			expect( envelope.message ).toContain( 'mode is not compatible with section=\'new\'' );
		} );
	} );
} );
