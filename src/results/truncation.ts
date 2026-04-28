export const DEFAULT_CONTENT_MAX_BYTES = 50000;

export function resolveContentMaxBytes(): number {
	const raw = process.env.MCP_CONTENT_MAX_BYTES;
	if ( raw === undefined || raw === '' ) {
		return DEFAULT_CONTENT_MAX_BYTES;
	}
	const parsed = Number.parseInt( raw, 10 );
	if ( !Number.isFinite( parsed ) || parsed <= 0 ) {
		return DEFAULT_CONTENT_MAX_BYTES;
	}
	return parsed;
}

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

export interface TruncatedContent {
	text: string;
	truncated: boolean;
	returnedBytes: number;
	totalBytes: number;
}

export function truncateByBytes(
	text: string,
	maxBytes: number = resolveContentMaxBytes()
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
