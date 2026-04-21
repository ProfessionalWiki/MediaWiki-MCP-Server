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

describe( 'parse-wikitext', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns HTML block for parsed wikitext', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>', parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( "'''Hello'''", undefined, true );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe( 'HTML:\n<p>Hello</p>' );
	} );

	it( 'places parse warnings as the first block', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>Body</p>',
					parsewarnings: [ 'Unclosed tag', 'Bad template' ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'anything', undefined, true );

		expect( result.isError ).toBeUndefined();
		expect( result.content[ 0 ].text ).toBe(
			'Parse warnings:\n- Unclosed tag\n- Bad template'
		);
		expect( result.content[ 1 ].text ).toBe( 'HTML:\n<p>Body</p>' );
	} );

	it( "defaults title to 'API' when omitted", async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>x</p>', parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		await handleParseWikitextTool( 'x', undefined, true );

		expect( mock.request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'parse',
			text: 'x',
			title: 'API',
			pst: true,
			formatversion: '2'
		} ) );
	} );

	it( 'passes provided title through to the API call', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>x</p>', parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		await handleParseWikitextTool( 'x', 'Custom Title', true );

		expect( mock.request ).toHaveBeenCalledWith( expect.objectContaining( {
			title: 'Custom Title'
		} ) );
	} );

	it( 'passes applyPreSaveTransform=false through as pst: false', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>x</p>', parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		await handleParseWikitextTool( 'x', undefined, false );

		expect( mock.request ).toHaveBeenCalledWith( expect.objectContaining( {
			pst: false
		} ) );
	} );

	it( 'wraps mwn errors as isError with message', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'Network down' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		expect( result.isError ).toBe( true );
		expect( result.content[ 0 ].text ).toBe(
			'Failed to preview wikitext: Network down'
		);
	} );
} );
