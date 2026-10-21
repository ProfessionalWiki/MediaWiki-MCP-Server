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
