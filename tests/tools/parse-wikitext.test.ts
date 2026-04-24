import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { TruncationSchema } from '../../src/common/schemas.js';

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

const ParseWikitextSchema = z.object( {
	html: z.string(),
	displayTitle: z.string().optional(),
	parseWarnings: z.array( z.string() ).optional(),
	categories: z.array( z.object( {
		category: z.string(),
		hidden: z.boolean().optional()
	} ) ).optional(),
	links: z.array( z.object( {
		title: z.string(),
		exists: z.boolean().optional()
	} ) ).optional(),
	templates: z.array( z.object( {
		title: z.string(),
		exists: z.boolean().optional()
	} ) ).optional(),
	externalLinks: z.array( z.string() ).optional(),
	truncation: TruncationSchema.optional()
} );

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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.html ).toBe( '<p>Hello</p>' );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.parseWarnings ).toEqual( [ 'Unclosed tag', 'Bad template' ] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.categories ).toEqual( [
			{ category: 'Foo', hidden: undefined },
			{ category: 'Hidden', hidden: true }
		] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.links ).toEqual( [
			{ title: 'Foo', exists: true },
			{ title: 'RedLink', exists: false }
		] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.templates ).toEqual( [
			{ title: 'Template:Infobox', exists: true },
			{ title: 'Template:Broken', exists: false }
		] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.externalLinks ).toEqual( [
			'https://example.org',
			'https://example.com/page'
		] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.displayTitle ).toBe( '<i>Custom Display</i>' );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.displayTitle ).toBeUndefined();
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data ).toEqual( { html: '<p>x</p>' } );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.html ).toHaveLength( 50000 );
		expect( data.truncation ).toMatchObject( {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 60007,
			itemNoun: 'HTML',
			toolName: 'parse-wikitext'
		} );
		expect( data.categories ).toEqual( [ { category: 'Foo', hidden: undefined } ] );
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

		const data = assertStructuredSuccess( result, ParseWikitextSchema );
		expect( data.html ).toBe( exact );
		expect( data.truncation ).toBeUndefined();
	} );
} );
