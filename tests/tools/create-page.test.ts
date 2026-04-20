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

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toContain( 'Page created successfully' );
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

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toContain( 'Page exists' );
	} );
} );
