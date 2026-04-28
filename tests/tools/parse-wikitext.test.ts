import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { parseWikitext } from '../../src/tools/parse-wikitext.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { formatPayload } from '../../src/results/format.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'parse-wikitext', () => {
	it( 'returns HTML for parsed wikitext', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>', parsewarnings: [] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: "'''Hello'''", applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'anything', applyPreSaveTransform: true },
			ctx
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Parse warnings:\n- Unclosed tag\n- Bad template' );
	} );

	it( "defaults title to 'API' when omitted", async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>x</p>', parsewarnings: [] }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await parseWikitext.handle(
			{ wikitext: 'x', title: 'Custom Title', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: false },
			ctx
		);

		expect( mock.request ).toHaveBeenCalledWith( expect.objectContaining( {
			pst: false
		} ) );
	} );

	it( 'wraps mwn errors as isError with message via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'Network down' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( parseWikitext, ctx )( {
			wikitext: 'x',
			applyPreSaveTransform: true
		} );

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', title: 'Custom Title', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await parseWikitext.handle(
			{ wikitext: 'x', applyPreSaveTransform: true },
			ctx
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toMatch( /HTML:\n\ny{50000}/ );
		expect( text ).not.toContain( 'Truncation:' );
	} );
} );
