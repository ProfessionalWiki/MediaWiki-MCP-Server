/* eslint-disable n/no-missing-import */
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

export const CONTENT_MAX_BYTES = 50000;

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
	}
	| {
		reason: 'content-truncated';
		returnedBytes: number;
		totalBytes: number;
		itemNoun: string;
		toolName: string;
		sections?: string[];
		remedyHint: string;
	};

function formatCursorValue( value: string | number ): string {
	return typeof value === 'number' ? String( value ) : `"${ value }"`;
}

function formatSectionsClause( sections: string[] ): string {
	const entries = sections.map( ( heading, index ) => {
		const label = index === 0 ? 'Lead' : heading;
		return `${ index } (${ label })`;
	} );
	return `Available sections: ${ entries.join( ', ' ) }.`;
}

export function truncationMarker( info: TruncationInfo ): TextContent {
	if ( info.reason === 'more-available' ) {
		const { param, value } = info.continueWith;
		return {
			type: 'text',
			text: `More results available. Returned ${ info.returnedCount } ${ info.itemNoun }. To fetch the next segment, call ${ info.toolName } again with ${ param }=${ formatCursorValue( value ) }.`
		};
	}
	if ( info.reason === 'content-truncated' ) {
		const parts = [
			`Content truncated at ${ info.returnedBytes } of ${ info.totalBytes } bytes.`
		];
		if ( info.sections && info.sections.length > 0 ) {
			parts.push( formatSectionsClause( info.sections ) );
		}
		parts.push( info.remedyHint );
		return { type: 'text', text: parts.join( ' ' ) };
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

export interface TruncatedContent {
	text: string;
	truncated: boolean;
	returnedBytes: number;
	totalBytes: number;
}

export function truncateByBytes(
	text: string,
	maxBytes: number = CONTENT_MAX_BYTES
): TruncatedContent {
	const buffer = Buffer.from( text, 'utf8' );
	const totalBytes = buffer.byteLength;
	if ( totalBytes <= maxBytes ) {
		return { text, truncated: false, returnedBytes: totalBytes, totalBytes };
	}
	// Slice on a byte boundary, then decode. Node's Buffer#toString handles
	// incomplete trailing UTF-8 sequences by replacing them with U+FFFD,
	// which is acceptable for a truncated preview.
	const sliced = buffer.subarray( 0, maxBytes ).toString( 'utf8' );
	return {
		text: sliced,
		truncated: true,
		returnedBytes: Buffer.byteLength( sliced, 'utf8' ),
		totalBytes
	};
}
