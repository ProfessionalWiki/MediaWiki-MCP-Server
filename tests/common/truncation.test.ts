import { describe, it, expect } from 'vitest';
/* eslint-disable n/no-missing-import */
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import {
	truncationMarker,
	appendTruncationMarker,
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
