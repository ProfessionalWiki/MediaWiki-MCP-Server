import type { CappedRows, TruncationInfo } from './truncation.ts';

export const MALFORMED_CONTINUE_FROM = 'continueFrom must be a non-negative integer';

// An offset-paged tool hands out `continueFrom` as the decimal offset to resume
// at, so anything else is a cursor it never issued.
export function offsetFrom(continueFrom: string | undefined): number | undefined {
	if (continueFrom === undefined) {
		return 0;
	}
	const offset = Number.parseInt(continueFrom, 10);
	return offset >= 0 && String(offset) === continueFrom ? offset : undefined;
}

export interface RowPage {
	toolName: string;
	offset: number;
	/** Where the wiki's next page starts, or undefined when it has no more rows. */
	nextOffset: number | undefined;
	/** How a caller makes each row smaller, as an action phrase. */
	narrowing: string;
}

/**
 * The marker for a page of rows from an offset-paged query, after the byte
 * budget kept what fits. Continuing resumes at the first row left out, whether
 * the budget or the wiki's page size ended the page.
 */
export function rowPageTruncation(
	capped: CappedRows<unknown>,
	page: RowPage,
): { truncation?: TruncationInfo } {
	if (capped.truncated && capped.rows.length === 0) {
		return {
			truncation: {
				reason: 'content-truncated',
				returnedBytes: 0,
				totalBytes: capped.totalBytes,
				itemNoun: 'rows',
				toolName: page.toolName,
				remedyHint: `To read a row larger than the whole byte budget, ${page.narrowing}, or skip it with continueFrom=${page.offset + 1}.`,
			},
		};
	}
	const nextOffset = capped.truncated ? page.offset + capped.rows.length : page.nextOffset;
	if (nextOffset === undefined) {
		return {};
	}
	return {
		truncation: {
			reason: 'more-available',
			returnedCount: capped.rows.length,
			itemNoun: 'rows',
			toolName: page.toolName,
			continueWith: { param: 'continueFrom', value: String(nextOffset) },
		},
	};
}
