import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { TruncationSchema } from '../../src/common/schemas.js';

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

const SideSchema = z.object( {
	title: z.string().optional(),
	revisionId: z.number().int().nonnegative().optional(),
	timestamp: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	isSuppliedText: z.boolean()
} );

const CompareSchema = z.object( {
	changed: z.boolean(),
	from: SideSchema,
	to: SideSchema,
	sizeDelta: z.number().int().optional(),
	diff: z.string().optional(),
	truncation: TruncationSchema.optional()
} );

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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data ).toMatchObject( {
			changed: true,
			from: {
				title: 'Foo',
				revisionId: 42,
				timestamp: '2026-01-01T00:00:00Z',
				size: 100,
				isSuppliedText: false
			},
			to: {
				title: 'Foo',
				revisionId: 57,
				timestamp: '2026-01-02T00:00:00Z',
				size: 105,
				isSuppliedText: false
			},
			sizeDelta: 5,
			diff: '@@ Line 1 @@\n- old\n+ new'
		} );

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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.changed ).toBe( true );
		expect( data.sizeDelta ).toBe( 5 );
		expect( data.diff ).toBeUndefined();
		expect( data.from.timestamp ).toBeUndefined();

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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.changed ).toBe( false );
		expect( data.sizeDelta ).toBe( 0 );
		expect( data.diff ).toBeUndefined();
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.from ).toMatchObject( {
			size: 50,
			isSuppliedText: true
		} );
		expect( data.to ).toMatchObject( {
			title: 'Foo',
			revisionId: 57,
			isSuppliedText: false
		} );

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

		const data = assertStructuredSuccess( result, CompareSchema );
		// 'hello world' is 11 bytes in UTF-8.
		expect( data.from.size ).toBe( 11 );
		expect( data.sizeDelta ).toBe( 89 );
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

	it( 'maps nosuchrevid errors to a friendly message with code', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'nosuchrevid: There is no revision with ID 99999.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromRevision: 99999, toRevision: 57
		} );

		assertStructuredError( result, 'not_found', 'nosuchrevid' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'maps missingtitle errors to a friendly message with code', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: The page you specified doesn\'t exist.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Nope', toTitle: 'Foo'
		} );

		assertStructuredError( result, 'not_found', 'missingtitle' );
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.changed ).toBe( false );
		expect( data.sizeDelta ).toBe( 0 );
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.changed ).toBe( false );
		expect( data.diff ).toBeUndefined();
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

		assertStructuredError( result, 'not_found', 'nosuchrevid' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Revision 99999 not found' );
	} );

	it( 'parses the correct title when missingtitle message quotes it', async () => {
		const request = vi.fn().mockRejectedValue( new Error( 'missingtitle: Page "Bar" not found.' ) );
		vi.mocked( getMwn ).mockResolvedValue( createMockMwn( { request } ) as any );

		const result = await handleComparePagesTool( {
			fromTitle: 'Foo', toTitle: 'Bar'
		} );

		assertStructuredError( result, 'not_found', 'missingtitle' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe( 'Page "Bar" not found' );
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.diff ).toHaveLength( 50000 );
		expect( data.truncation ).toMatchObject( {
			reason: 'content-truncated',
			returnedBytes: 50000,
			itemNoun: 'diff',
			toolName: 'compare-pages'
		} );
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.truncation ).toBeUndefined();
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

		const data = assertStructuredSuccess( result, CompareSchema );
		expect( data.changed ).toBe( true );
		expect( data.sizeDelta ).toBe( 0 );
	} );
} );
