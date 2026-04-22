/* eslint-disable n/no-missing-import */
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

export type TruncationInfo =
	| {
		reason: 'more-available';
		returnedCount: number;
		itemNoun: string;
		toolName: string;
		continueWith: { param: string; value: string | number };
	}
	| {
		reason: 'capped-no-continuation';
		returnedCount: number;
		limit: number;
		itemNoun: string;
		narrowHint: string;
	};

function formatCursorValue( value: string | number ): string {
	return typeof value === 'number' ? String( value ) : `"${ value }"`;
}

export function truncationMarker( info: TruncationInfo ): TextContent {
	if ( info.reason === 'more-available' ) {
		const { param, value } = info.continueWith;
		return {
			type: 'text',
			text: `More results available. Returned ${ info.returnedCount } ${ info.itemNoun }. To fetch the next segment, call ${ info.toolName } again with ${ param }=${ formatCursorValue( value ) }.`
		};
	}
	return {
		type: 'text',
		text: `Result capped at ${ info.limit } ${ info.itemNoun }. Additional ${ info.itemNoun } may exist — ${ info.narrowHint }.`
	};
}

export function appendTruncationMarker(
	content: TextContent[],
	info: TruncationInfo | null
): TextContent[] {
	if ( info === null ) {
		return content;
	}
	return [ ...content, truncationMarker( info ) ];
}
