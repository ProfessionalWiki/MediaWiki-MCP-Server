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

	it( 'formats categories with (hidden) suffix', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					categories: [
						{ sortkey: '', category: 'Foo' },
						{ sortkey: '', category: 'Hidden', hidden: true }
					]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const categoriesBlock = result.content.find( ( c ) => c.text?.startsWith( 'Categories:' ) );
		expect( categoriesBlock?.text ).toBe(
			'Categories:\n- Category:Foo\n- Category:Hidden (hidden)'
		);
	} );

	it( 'formats links with (missing) suffix for red links', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					links: [
						{ ns: 0, title: 'Foo', exists: true },
						{ ns: 0, title: 'RedLink', exists: false }
					]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const linksBlock = result.content.find( ( c ) => c.text?.startsWith( 'Links:' ) );
		expect( linksBlock?.text ).toBe( 'Links:\n- Foo\n- RedLink (missing)' );
	} );

	it( 'formats templates with (missing) suffix', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					templates: [
						{ ns: 10, title: 'Template:Infobox', exists: true },
						{ ns: 10, title: 'Template:Broken', exists: false }
					]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const templatesBlock = result.content.find( ( c ) => c.text?.startsWith( 'Templates:' ) );
		expect( templatesBlock?.text ).toBe(
			'Templates:\n- Template:Infobox\n- Template:Broken (missing)'
		);
	} );

	it( 'formats external links as simple bullet list', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					externallinks: [ 'https://example.org', 'https://example.com/page' ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const externalsBlock = result.content.find( ( c ) => c.text?.startsWith( 'External links:' ) );
		expect( externalsBlock?.text ).toBe(
			'External links:\n- https://example.org\n- https://example.com/page'
		);
	} );

	it( 'includes display title only when it differs from the input title', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					displaytitle: '<i>Custom Display</i>'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', 'Custom Title', true );

		const dtBlock = result.content.find( ( c ) => c.text?.startsWith( 'Display title:' ) );
		expect( dtBlock?.text ).toBe( 'Display title: <i>Custom Display</i>' );
	} );

	it( 'skips display title when it matches the input title', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					displaytitle: 'API'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		expect( result.content.some( ( c ) => c.text?.startsWith( 'Display title:' ) ) ).toBe( false );
	} );

	it( 'skips empty sections entirely', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [],
					categories: [],
					links: [],
					templates: [],
					externallinks: [],
					displaytitle: 'API'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		expect( result.content.length ).toBe( 1 );
		expect( result.content[ 0 ].text ).toBe( 'HTML:\n<p>x</p>' );
	} );

	it( 'emits sections in order: warnings, HTML, displaytitle, categories, links, templates, externallinks', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: '<p>x</p>',
					parsewarnings: [ 'warn' ],
					categories: [ { sortkey: '', category: 'Foo' } ],
					links: [ { ns: 0, title: 'L', exists: true } ],
					templates: [ { ns: 10, title: 'Template:T', exists: true } ],
					externallinks: [ 'https://example.org' ],
					displaytitle: '<i>Different</i>'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', 'Plain', true );

		const prefixes = result.content.map( ( c ) => c.text!.split( ':' )[ 0 ] + ':' );
		expect( prefixes ).toEqual( [
			'Parse warnings:',
			'HTML:',
			'Display title:',
			'Categories:',
			'Links:',
			'Templates:',
			'External links:'
		] );
	} );
} );
