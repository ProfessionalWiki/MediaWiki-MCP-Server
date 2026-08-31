/**
 * The error a promise rejects with, as a value. Tests that assert several
 * things about one rejection cannot use `expect(...).rejects`, which takes a
 * single matcher.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(err: unknown) => err,
	);
}
