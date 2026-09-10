export const DEFAULT_CONTENT_MAX_BYTES = 100000;

/** The response content byte budget in force, for callers that cap before rendering. */
export function contentMaxBytes(): number {
	const raw = process.env.MCP_CONTENT_MAX_BYTES;
	if (raw === undefined || raw === '') {
		return DEFAULT_CONTENT_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
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

export interface CappedLines {
	lines: string[];
	returnedBytes: number;
	totalBytes: number;
	truncated: boolean;
}

const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8');

/**
 * Keeps whole lines while they fit the response byte budget, so a caller never
 * receives a half-written line of a line-oriented result. A first line that alone
 * exceeds the budget is cut inside and marked, since an empty block tells the
 * caller less than a visibly truncated line does.
 */
export function capLinesByBytes(lines: string[]): CappedLines {
	const maxBytes = contentMaxBytes();
	const totalBytes = Buffer.byteLength(lines.join('\n'), 'utf8');
	if (totalBytes <= maxBytes) {
		return { lines, returnedBytes: totalBytes, totalBytes, truncated: false };
	}

	const kept: string[] = [];
	let returnedBytes = 0;
	for (const line of lines) {
		const separator = kept.length === 0 ? 0 : 1;
		const size = separator + Buffer.byteLength(line, 'utf8');
		if (returnedBytes + size > maxBytes) {
			break;
		}
		kept.push(line);
		returnedBytes += size;
	}

	if (kept.length === 0) {
		const { text } = truncateByBytes(lines[0], Math.max(0, maxBytes - ELLIPSIS_BYTES));
		const only = `${text}${ELLIPSIS}`;
		return {
			lines: [only],
			returnedBytes: Buffer.byteLength(only, 'utf8'),
			totalBytes,
			truncated: true,
		};
	}
	return { lines: kept, returnedBytes, totalBytes, truncated: true };
}

// UTF-8 continuation bytes are 0b10xxxxxx. A cut whose next byte is one of them
// lands inside a multi-byte character.
function isContinuationByte(byte: number): boolean {
	return (byte & 0xc0) === 0x80;
}

export function truncateByBytes(
	text: string,
	maxBytes: number = contentMaxBytes(),
): TruncatedContent {
	const buffer = Buffer.from(text, 'utf8');
	const totalBytes = buffer.byteLength;
	if (totalBytes <= maxBytes) {
		return { text, truncated: false, returnedBytes: totalBytes, totalBytes };
	}
	// Cut back to a character boundary, so the text returned is a byte-exact
	// prefix of the input. Slicing mid-sequence leaves Node decoding the partial
	// character as U+FFFD, which both pushes the result past maxBytes and puts a
	// character in the caller's copy that the page never contained.
	// Clamped here rather than at the call sites, because maxBytes is a public
	// parameter and a negative one would make subarray count from the end.
	let end = Math.max(0, maxBytes);
	while (end > 0 && isContinuationByte(buffer[end])) {
		end--;
	}
	return {
		text: buffer.subarray(0, end).toString('utf8'),
		truncated: true,
		returnedBytes: end,
		totalBytes,
	};
}
