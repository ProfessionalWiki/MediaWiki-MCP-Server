import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
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
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: true' );
		expect( text ).toContain( 'From:' );
		expect( text ).toContain( '  Title: Foo' );
		expect( text ).toContain( '  Revision ID: 42' );
		expect( text ).toContain( '  Timestamp: 2026-01-01T00:00:00Z' );
		expect( text ).toContain( '  Size: 100' );
		expect( text ).toContain( '  Is supplied text: false' );
		expect( text ).toContain( 'To:' );
		expect( text ).toContain( '  Revision ID: 57' );
		expect( text ).toContain( '  Timestamp: 2026-01-02T00:00:00Z' );
		expect( text ).toContain( '  Size: 105' );
		expect( text ).toContain( 'Size delta: 5' );
		expect( text ).toContain( '@@ Line 1 @@\n- old\n+ new' );

		const call = request.mock.calls[ 0 ][ 0 ];
		expect( call.action ).toBe( 'compare' );
		expect( call.fromrev ).toBe( 42 );
		expect( call.torev ).toBe( 57 );
		expect( call.prop ).toContain( 'diff' );
	} );

	it( 'cheap mode omits diff from prop and payload', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: true' );
		expect( text ).toContain( 'Size delta: 5' );
		expect( text ).not.toContain( 'Diff:' );
		expect( text ).not.toContain( '  Timestamp:' );

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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: false' );
		expect( text ).toContain( 'Size delta: 0' );
		expect( text ).not.toContain( 'Diff:' );
	} );

	it( 'sets isSuppliedText on the supplied-text side', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'From:' );
		expect( text ).toContain( '  Size: 50' );
		expect( text ).toContain( '  Is supplied text: true' );
		expect( text ).toContain( 'To:' );
		expect( text ).toContain( '  Title: Foo' );
		expect( text ).toContain( '  Revision ID: 57' );
		expect( text ).toContain( '  Is supplied text: false' );

		const call = request.mock.calls[ 0 ][ 0 ];
		expect( call.fromslots ).toBe( 'main' );
		expect( call[ 'fromtext-main' ] ).toBe( 'my draft' );
		expect( call.totitle ).toBe( 'Foo' );
	} );

	it( 'computes byte size locally when MediaWiki omits it for supplied text', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		// 'hello world' is 11 bytes in UTF-8.
		expect( text ).toContain( '  Size: 11' );
		expect( text ).toContain( 'Size delta: 89' );
	} );

	it( 'returns validation error when no from* is given', async () => {
		const result = await handleComparePagesTool( { toRevision: 57 } );
		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toBe(
			'Must supply exactly one of fromRevision, fromTitle, fromText'
		);
	} );

	it( 'returns validation error when multiple from* are given', async () => {
		const result = await handleComparePagesTool( {
			fromRevision: 42, fromTitle: 'Foo', toRevision: 57
		} );
		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toBe(
			'Only one of fromRevision, fromTitle, fromText may be supplied'
		);
	} );

	it( 'rejects text-vs-text comparison', async () => {
		const result = await handleComparePagesTool( {
			fromText: 'a', toText: 'b'
		} );
		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toBe(
			'Cannot compare supplied text against supplied text'
		);
	} );

	it( 'maps nosuchrevid errors to a friendly message with code', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'nosuchrevid: There is no revision with ID 99999.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 99999, toRevision: 57
		} );

		const envelope = assertStructuredError( result, 'not_found', 'nosuchrevid' );
		expect( envelope.message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'maps missingtitle errors to a friendly message with code', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: The page you specified doesn\'t exist.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Nope', toTitle: 'Foo'
		} );

		const envelope = assertStructuredError( result, 'not_found', 'missingtitle' );
		expect( envelope.message ).toBe( 'Page "Nope" not found' );
	} );

	it( 'returns a generic error message for other API failures', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'Connection refused' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toBe(
			'Failed to compare pages: Connection refused'
		);
	} );

	it( 'returns validation error when multiple to* are given', async () => {
		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57, toTitle: 'Foo'
		} );
		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toBe(
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: false' );
		expect( text ).toContain( 'Size delta: 0' );
	} );

	it( 'full mode omits diff field when body is empty', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: false' );
		expect( text ).not.toContain( 'Diff:' );
	} );

	it( 'returns error when API response has no compare field', async () => {
		const request = vi.fn().mockResolvedValue( {} );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 57
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toBe(
			'Failed to compare pages: no compare result returned'
		);
	} );

	it( 'parses the correct revid when both revisions are supplied and the to side is missing', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'nosuchrevid: There is no revision with ID 99999.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 42, toRevision: 99999
		} );

		const envelope = assertStructuredError( result, 'not_found', 'nosuchrevid' );
		expect( envelope.message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'parses the correct title when missingtitle message quotes it', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: Page "Bar" not found.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Foo', toTitle: 'Bar'
		} );

		const envelope = assertStructuredError( result, 'not_found', 'missingtitle' );
		expect( envelope.message ).toBe( 'Page "Bar" not found' );
	} );

	it( 'truncates oversized diff with a content-truncated truncation field', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Item noun: diff' );
		expect( text ).toContain( '  Tool name: compare-pages' );
	} );

	it( 'cheap mode (includeDiff=false) never attaches a content-truncated truncation', async () => {
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).not.toContain( 'Truncation:' );
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

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Changed: true' );
		expect( text ).toContain( 'Size delta: 0' );
	} );
} );
