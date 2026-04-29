type ErrnoLike = NodeJS.ErrnoException & {
	signal?: string;
	status?: number | null;
	stderr?: Buffer | string;
};

/**
 * Type predicate that narrows an unknown caught value to ErrnoLike.
 *
 * Body checks `err instanceof Error` only — the optional Errno fields
 * (`code`, `signal`, `status`, `stderr`) are NOT verified at runtime.
 * Callers should use equality checks (e.g. `if (err.code === 'ENOENT')`)
 * rather than truthiness, since a plain `new Error('x')` passes this
 * predicate and `err.code` will be `undefined`.
 */
export function isErrnoException(err: unknown): err is ErrnoLike {
	return err instanceof Error;
}

export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
	return err instanceof Error ? err.message : fallback;
}
