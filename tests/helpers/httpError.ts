/** An axios-style rejection for a non-2xx response: a thrown error carrying `.response`. */
export function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}
