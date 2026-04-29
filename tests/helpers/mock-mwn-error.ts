/**
 * Constructs an MwnError-shaped object for tests that need to simulate a
 * specific MediaWiki API failure without pulling in mwn's runtime.
 */
export function createMockMwnError(
	code: string,
	message?: string,
): Error & { code: string; info?: string } {
	const err = new Error(message ?? `${code}: mock MediaWiki error`) as Error & {
		code: string;
		info?: string;
	};
	err.code = code;
	err.info = message ?? `mock info for ${code}`;
	return err;
}
