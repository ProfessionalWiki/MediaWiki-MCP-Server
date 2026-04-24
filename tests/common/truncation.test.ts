import { describe, it, expect } from 'vitest';
/* eslint-disable n/no-missing-import */
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import {
	truncationMarker,
	appendTruncationMarker,
	truncateByBytes,
	CONTENT_MAX_BYTES,
	type TruncationInfo
} from '../../src/common/truncation.js';

describe( 'truncationMarker', () => {
	it( 'renders more-available with a numeric cursor value unquoted', () => {
		const info: TruncationInfo = {
			reason: 'more-available',
			returnedCount: 20,
			itemNoun: 'revisions',
			toolName: 'get-page-history',
			continueWith: { param: 'olderThan', value: 42 }
		};
		expect( truncationMarker( info ) ).toEqual( {
			type: 'text',
			text: 'More results available. Returned 20 revisions. To fetch the next segment, call get-page-history again with olderThan=42.'
		} );
	} );

	it( 'renders more-available with a string cursor value double-quoted', () => {
		const info: TruncationInfo = {
			reason: 'more-available',
			returnedCount: 500,
			itemNoun: 'members',
			toolName: 'get-category-members',
			continueWith: { param: 'continueFrom', value: 'page|DOE|123' }
		};
		expect( truncationMarker( info ).text ).toBe(
			'More results available. Returned 500 members. To fetch the next segment, call get-category-members again with continueFrom="page|DOE|123".'
		);
	} );

	it( 'renders content-truncated without a section list', () => {
		const info: TruncationInfo = {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 120000,
			itemNoun: 'HTML',
			toolName: 'parse-wikitext',
			remedyHint: 'To avoid truncation, render a smaller wikitext fragment in a follow-up call.'
		};
		expect( truncationMarker( info ).text ).toBe(
			'Content truncated at 50000 of 120000 bytes. To avoid truncation, render a smaller wikitext fragment in a follow-up call.'
		);
	} );

	it( 'renders content-truncated with a section list (section 0 labeled Lead)', () => {
		const info: TruncationInfo = {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 200000,
			itemNoun: 'wikitext',
			toolName: 'get-page',
			sections: [ '', 'History', 'Background' ],
			remedyHint: 'To read a specific section, call get-page again with section=N.'
		};
		expect( truncationMarker( info ).text ).toBe(
			'Content truncated at 50000 of 200000 bytes. Available sections: 0 (Lead), 1 (History), 2 (Background). To read a specific section, call get-page again with section=N.'
		);
	} );

	it( 'renders content-truncated with an empty section list by omitting the sections clause', () => {
		const info: TruncationInfo = {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 120000,
			itemNoun: 'wikitext',
			toolName: 'get-page',
			sections: [],
			remedyHint: 'To read a specific section, call get-page again with section=N.'
		};
		expect( truncationMarker( info ).text ).toBe(
			'Content truncated at 50000 of 120000 bytes. To read a specific section, call get-page again with section=N.'
		);
	} );

	it( 'renders capped-no-continuation with em dash before narrow hint', () => {
		const info: TruncationInfo = {
			reason: 'capped-no-continuation',
			returnedCount: 100,
			limit: 100,
			itemNoun: 'matches',
			narrowHint: 'narrow the query or raise limit (max 100)'
		};
		expect( truncationMarker( info ).text ).toBe(
			'Result capped at 100 matches. Additional matches may exist — narrow the query or raise limit (max 100).'
		);
	} );
} );

describe( 'CONTENT_MAX_BYTES', () => {
	it( 'is exported and equals 50000', () => {
		expect( CONTENT_MAX_BYTES ).toBe( 50000 );
	} );
} );

describe( 'truncateByBytes', () => {
	it( 'returns the input unchanged when under the limit', () => {
		const result = truncateByBytes( 'hello', 100 );
		expect( result.truncated ).toBe( false );
		expect( result.text ).toBe( 'hello' );
		expect( result.returnedBytes ).toBe( 5 );
		expect( result.totalBytes ).toBe( 5 );
	} );

	it( 'returns the input unchanged at exactly the limit', () => {
		const result = truncateByBytes( 'x'.repeat( 100 ), 100 );
		expect( result.truncated ).toBe( false );
		expect( result.returnedBytes ).toBe( 100 );
		expect( result.totalBytes ).toBe( 100 );
	} );

	it( 'truncates when the input exceeds the limit', () => {
		const input = 'x'.repeat( 200 );
		const result = truncateByBytes( input, 100 );
		expect( result.truncated ).toBe( true );
		expect( result.returnedBytes ).toBe( 100 );
		expect( result.totalBytes ).toBe( 200 );
		expect( result.text.length ).toBe( 100 );
	} );

	it( 'defaults to CONTENT_MAX_BYTES when no limit is passed', () => {
		const input = 'x'.repeat( CONTENT_MAX_BYTES + 1 );
		const result = truncateByBytes( input );
		expect( result.truncated ).toBe( true );
		expect( result.returnedBytes ).toBe( CONTENT_MAX_BYTES );
		expect( result.totalBytes ).toBe( CONTENT_MAX_BYTES + 1 );
	} );

	it( 'handles a multi-byte UTF-8 character straddling the byte boundary', () => {
		// '漢' is 3 bytes in UTF-8. Build a buffer whose first 100 bytes split
		// the final character across the limit so the slice lands mid-sequence.
		const input = 'x'.repeat( 99 ) + '漢漢';
		const result = truncateByBytes( input, 100 );
		expect( result.truncated ).toBe( true );
		// Buffer#toString('utf8') replaces the partial trailing byte with U+FFFD;
		// returnedBytes reflects the decoded string's UTF-8 length, which may
		// exceed the raw 100-byte slice but stays bounded by maxBytes + 2 bytes
		// of replacement.
		expect( result.totalBytes ).toBe( 99 + 6 );
		expect( result.returnedBytes ).toBeLessThanOrEqual( 100 + 2 );
		// The returned text must decode cleanly as a string (no thrown decode error)
		expect( typeof result.text ).toBe( 'string' );
	} );
} );

describe( 'appendTruncationMarker', () => {
	it( 'returns input content unchanged when info is null', () => {
		const content: TextContent[] = [
			{ type: 'text', text: 'one' },
			{ type: 'text', text: 'two' }
		];
		expect( appendTruncationMarker( content, null ) ).toEqual( content );
	} );

	it( 'appends exactly one marker block when info is non-null', () => {
		const content: TextContent[] = [ { type: 'text', text: 'one' } ];
		const info: TruncationInfo = {
			reason: 'capped-no-continuation',
			returnedCount: 10,
			limit: 10,
			itemNoun: 'titles',
			narrowHint: 'narrow the prefix'
		};
		const result = appendTruncationMarker( content, info );
		expect( result ).toHaveLength( 2 );
		expect( result[ 0 ] ).toEqual( { type: 'text', text: 'one' } );
		expect( result[ 1 ].text ).toContain( 'Result capped at 10 titles' );
	} );
} );
