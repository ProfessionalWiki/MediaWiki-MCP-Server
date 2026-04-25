import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { formatPayload } from '../../src/common/formatPayload.js';

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

describe( 'parse-wikitext', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns HTML for parsed wikitext', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>', parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( "'''Hello'''", undefined, true );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
	} );

	it( 'includes parse warnings when present', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Parse warnings:\n- Unclosed tag\n- Bad template' );
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

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toBe(
			'Failed to preview wikitext: Network down'
		);
	} );

	it( 'preserves categories with hidden flag', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Categories:' );
		expect( text ).toContain( '- Category: Foo' );
		expect( text ).toContain( '- Category: Hidden' );
		expect( text ).toContain( '  Hidden: true' );
	} );

	it( 'preserves links with exists flag (defaults missing exists to true)', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Links:' );
		expect( text ).toContain( '- Title: Foo' );
		expect( text ).toContain( '  Exists: true' );
		expect( text ).toContain( '- Title: RedLink' );
		expect( text ).toContain( '  Exists: false' );
	} );

	it( 'preserves templates with exists flag', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Templates:' );
		expect( text ).toContain( '- Title: Template:Infobox' );
		expect( text ).toContain( '  Exists: true' );
		expect( text ).toContain( '- Title: Template:Broken' );
		expect( text ).toContain( '  Exists: false' );
	} );

	it( 'preserves external links as a simple array', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'External links:\n- https://example.org\n- https://example.com/page' );
	} );

	it( 'includes displayTitle only when it differs from the input title', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Display title: <i>Custom Display</i>' );
	} );

	it( 'omits displayTitle when it matches the input title', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Display title:' );
	} );

	it( 'omits empty sections entirely', async () => {
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

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( { html: '<p>x</p>' } ) );
	} );

	it( 'attaches content-truncated truncation when HTML exceeds the byte cap', async () => {
		const bigHtml = '<p>' + 'x'.repeat( 60000 ) + '</p>';
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					text: bigHtml,
					parsewarnings: [],
					categories: [ { sortkey: '', category: 'Foo' } ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const text = assertStructuredSuccess( result );
		expect( text ).toMatch( /HTML:\n\n<p>x+/ );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Total bytes: 60007' );
		expect( text ).toContain( '  Item noun: HTML' );
		expect( text ).toContain( '  Tool name: parse-wikitext' );
		expect( text ).toContain( 'Categories:\n- Category: Foo' );
	} );

	it( 'omits truncation when HTML is exactly at the byte cap', async () => {
		const exact = 'y'.repeat( 50000 );
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: exact, parsewarnings: [] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleParseWikitextTool } = await import( '../../src/tools/parse-wikitext.js' );
		const result = await handleParseWikitextTool( 'x', undefined, true );

		const text = assertStructuredSuccess( result );
		expect( text ).toMatch( /HTML:\n\ny{50000}/ );
		expect( text ).not.toContain( 'Truncation:' );
	} );
} );
