/** An axios-style rejection for a non-2xx response: a thrown error carrying `.response`. */
export function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

/** What MediaWiki answers for a REST path no handler serves, such as an endpoint the extension lacks. */
export const noSuchRestPathBody = {
	errorKey: 'rest-no-match',
	messageTranslations: { en: 'The requested relative path did not match any known handler' },
	httpCode: 404,
	httpReason: 'Not Found',
};
