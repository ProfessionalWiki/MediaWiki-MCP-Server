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
import { handleComparePagesTool } from '../../src/tools/compare-pages.js';
import { assertStructuredError } from '../helpers/structuredResult.js';

const PAIRED_CHANGE_HTML = [
	'<table class="diff">',
	'<tr><td colspan="2" class="diff-lineno">Line 1:</td><td colspan="2" class="diff-lineno">Line 1:</td></tr>',
	'<tr><td class="diff-marker">-</td><td class="diff-deletedline"><div>old</div></td>',
	'<td class="diff-marker">+</td><td class="diff-addedline"><div>new</div></td></tr>',
	'</table>'
].join( '' );

describe( 'compare-pages', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns a full-mode diff between two revisions', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42,
				fromtitle: 'Foo',
				fromsize: 100,
				fromtimestamp: '2026-01-01T00:00:00Z',
				torevid: 57,
				totitle: 'Foo',
				tosize: 105,
				totimestamp: '2026-01-02T00:00:00Z',
				body: PAIRED_CHANGE_HTML
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 2 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: true' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'From: Foo @ rev 42 (2026-01-01T00:00:00Z, 100 bytes)' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'To:   Foo @ rev 57 (2026-01-02T00:00:00Z, 105 bytes)' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: +5' );
		expect( ( result.content[ 1 ] as { text: string } ).text ).toBe( '@@ Line 1 @@\n- old\n+ new' );

		const call = request.mock.calls[ 0 ][ 0 ];
		expect( call.action ).toBe( 'compare' );
		expect( call.fromrev ).toBe( 42 );
		expect( call.torev ).toBe( 57 );
		expect( call.prop ).toContain( 'diff' );
	} );

	it( 'cheap mode omits diff from prop and returns one block', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100,
				torevid: 57, totitle: 'Foo', tosize: 105
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57, includeDiff: false
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: true' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: +5' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).not.toContain( '2026-' );

		const call = request.mock.calls[ 0 ][ 0 ];
		expect( call.prop.split( '|' ) ).not.toContain( 'diff' );
		expect( call.prop.split( '|' ) ).toContain( 'diffsize' );
	} );

	it( 'reports no change when revids match and sizes match', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100,
				torevid: 42, totitle: 'Foo', tosize: 100,
				body: ''
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Foo', toRevision: 42
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: false' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: 0' );
	} );

	it( 'renders supplied text side as "(supplied text, N bytes)"', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromsize: 50,
				torevid: 57, totitle: 'Foo', tosize: 100, totimestamp: '2026-01-02T00:00:00Z',
				body: PAIRED_CHANGE_HTML
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromText: 'my draft', toTitle: 'Foo'
		} );

		expect( result.isError ).toBeUndefined();
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'From: Foo (supplied text, 50 bytes)' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'To:   Foo @ rev 57' );

		const call = request.mock.calls[ 0 ][ 0 ];
		expect( call.fromslots ).toBe( 'main' );
		expect( call[ 'fromtext-main' ] ).toBe( 'my draft' );
		expect( call.totitle ).toBe( 'Foo' );
	} );

	it( 'computes byte size locally when MediaWiki omits it for supplied text', async () => {
		// MediaWiki's action=compare omits fromsize/tosize for supplied-text
		// sides. The tool must fall back to the client-side byte length.
		const request = vi.fn().mockResolvedValue( {
			compare: {
				torevid: 57, totitle: 'Foo', tosize: 100,
				body: PAIRED_CHANGE_HTML
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromText: 'hello world', toTitle: 'Foo'
		} );

		expect( result.isError ).toBeUndefined();
		// 'hello world' is 11 bytes in UTF-8.
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'From: Foo (supplied text, 11 bytes)' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: +89' );
	} );

	it( 'returns validation error when no from* is given', async () => {
		const result = await handleComparePagesTool( { toRevision: 57 } );
		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Must supply exactly one of fromRevision, fromTitle, fromText'
		);
	} );

	it( 'returns validation error when multiple from* are given', async () => {
		const result = await handleComparePagesTool( {
			fromRevision: 42, fromTitle: 'Foo', toRevision: 57
		} );
		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Only one of fromRevision, fromTitle, fromText may be supplied'
		);
	} );

	it( 'rejects text-vs-text comparison', async () => {
		const result = await handleComparePagesTool( {
			fromText: 'a', toText: 'b'
		} );
		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Cannot compare supplied text against supplied text'
		);
	} );

	it( 'maps nosuchrevid errors to a friendly message', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'nosuchrevid: There is no revision with ID 99999.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 99999, toRevision: 57
		} );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'maps missingtitle errors to a friendly message', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: The page you specified doesn\'t exist.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Nope', toTitle: 'Foo'
		} );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Page "Nope" not found' );
	} );

	it( 'returns a generic error message for other API failures', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'Connection refused' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Failed to compare pages: Connection refused'
		);
	} );

	it( 'returns validation error when multiple to* are given', async () => {
		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57, toTitle: 'Foo'
		} );
		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Only one of toRevision, toTitle, toText may be supplied'
		);
	} );

	it( 'cheap mode reports unchanged when revids match', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100,
				torevid: 42, totitle: 'Foo', tosize: 100
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Foo', toRevision: 42, includeDiff: false
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: false' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: 0' );
	} );

	it( 'full mode returns only the header when body is empty', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100,
				torevid: 42, totitle: 'Foo', tosize: 100,
				body: ''
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 42
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: false' );
	} );

	it( 'returns error when API response has no compare field', async () => {
		const request = vi.fn().mockResolvedValue( {} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Failed to compare pages: no compare result returned'
		);
	} );

	it( 'parses the correct revid when both revisions are supplied and the to side is missing', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'nosuchrevid: There is no revision with ID 99999.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 99999
		} );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'parses the correct title when missingtitle message quotes it', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: Page "Bar" not found.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Foo', toTitle: 'Bar'
		} );

		assertStructuredError( result, 'not_found' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Page "Bar" not found' );
	} );

	it( 'truncates oversized diff body with a content-truncated marker', async () => {
		// Build a diff body large enough that inlineDiffToText yields > 50000 bytes
		const bigOld = 'a'.repeat( 30000 );
		const bigNew = 'b'.repeat( 30000 );
		const bigDiffHtml = [
			'<table class="diff">',
			'<tr><td colspan="2" class="diff-lineno">Line 1:</td><td colspan="2" class="diff-lineno">Line 1:</td></tr>',
			`<tr><td class="diff-marker">-</td><td class="diff-deletedline"><div>${ bigOld }</div></td>`,
			`<td class="diff-marker">+</td><td class="diff-addedline"><div>${ bigNew }</div></td></tr>`,
			'</table>'
		].join( '' );
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100, fromtimestamp: '2026-01-01T00:00:00Z',
				torevid: 57, totitle: 'Foo', tosize: 100, totimestamp: '2026-01-02T00:00:00Z',
				body: bigDiffHtml
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 3 );
		expect( ( result.content[ 1 ] as any ).text ).toHaveLength( 50000 );
		const marker = ( result.content[ 2 ] as any ).text as string;
		expect( marker ).toMatch( /^Content truncated at 50000 of \d+ bytes\./ );
		expect( marker ).toContain( 'compare a narrower revision range or set includeDiff=false' );
		expect( marker ).not.toContain( 'Available sections' );
	} );

	it( 'cheap mode (includeDiff=false) emits no content-truncated marker even for oversized changes', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				fromrevid: 42, fromtitle: 'Foo', fromsize: 100,
				torevid: 57, totitle: 'Foo', tosize: 100000,
				diffsize: 99999
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57, includeDiff: false
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		const hasMarker = result.content.some(
			( c: any ) => c.text?.startsWith( 'Content truncated at' )
		);
		expect( hasMarker ).toBe( false );
	} );

	it( 'cheap mode uses diffsize to detect same-byte-count changes', async () => {
		const request = vi.fn().mockResolvedValue( {
			compare: {
				torevid: 57, totitle: 'Foo', tosize: 12,
				fromsize: 12,
				diffsize: 80
			}
		} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromText: 'hallo world!', toTitle: 'Foo', includeDiff: false
		} );

		expect( result.isError ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Changed: true' );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain( 'Size delta: 0' );
	} );
} );
