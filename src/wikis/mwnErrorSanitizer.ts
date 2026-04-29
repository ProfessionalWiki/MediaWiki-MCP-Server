const REDACTED = '[REDACTED]';

const SENSITIVE_HEADER_PATTERN = /^(?:proxy-)?authorization$/i;

function isRecord(x: unknown): x is Record<string, unknown> {
	return x !== null && typeof x === 'object';
}

function redactHeadersObject(obj: unknown): void {
	if (!isRecord(obj)) {
		return;
	}
	const headers = obj.headers;
	if (!isRecord(headers)) {
		return;
	}
	for (const key of Object.keys(headers)) {
		if (SENSITIVE_HEADER_PATTERN.test(key)) {
			headers[key] = REDACTED;
		}
	}
}

export function redactAuthorizationHeader(err: unknown, token?: string): void {
	if (!(err instanceof Error) || !isRecord(err)) {
		return;
	}
	redactHeadersObject(err.request);
	redactHeadersObject(err.config);
	if (isRecord(err.response)) {
		redactHeadersObject(err.response.config);
	}
	// replaceAll with a string pattern does literal (non-regex) replacement —
	// do not "refactor" this to a RegExp, which would misbehave on special chars in the token.
	if (token && typeof err.message === 'string' && err.message.includes(token)) {
		err.message = err.message.replaceAll(token, REDACTED);
	}
	if (token && typeof err.stack === 'string' && err.stack.includes(token)) {
		err.stack = err.stack.replaceAll(token, REDACTED);
	}
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
	);
}

// Wrap an async iterable (e.g. mwn's *Gen methods, which return AsyncGenerators
// — both iterable and iterator) so rejections from .next() / .return() / .throw()
// during iteration go through the same redaction path as rejections from
// Promise-returning methods.
function wrapAsyncIterable<T>(
	iter: AsyncIterable<T>,
	token: string | undefined,
): AsyncIterableIterator<T> {
	const inner = iter[Symbol.asyncIterator]();
	const sanitise = <R>(p: Promise<R>): Promise<R> =>
		p.catch((err: unknown) => {
			redactAuthorizationHeader(err, token);
			throw err;
		});
	const wrapped: AsyncIterableIterator<T> = {
		[Symbol.asyncIterator](): AsyncIterableIterator<T> {
			return wrapped;
		},
		next: (...args) => sanitise(inner.next(...args)),
		return: inner.return ? (value) => sanitise(inner.return!(value)) : undefined,
		throw: inner.throw ? (e) => sanitise(inner.throw!(e)) : undefined,
	};
	return wrapped;
}

export function wrapMwnErrors<T extends object>(target: T, token?: string): T {
	return new Proxy(target, {
		get(obj, prop, receiver): unknown {
			const value = Reflect.get(obj, prop, receiver);
			if (typeof value !== 'function') {
				return value;
			}
			return function (this: unknown, ...args: unknown[]): unknown {
				try {
					const result = (value as (...a: unknown[]) => unknown).apply(
						this === receiver ? obj : this,
						args,
					);
					if (result && typeof (result as Promise<unknown>).then === 'function') {
						return (result as Promise<unknown>).catch((err: unknown) => {
							redactAuthorizationHeader(err, token);
							throw err;
						});
					}
					if (isAsyncIterable(result)) {
						return wrapAsyncIterable(result, token);
					}
					return result;
				} catch (err) {
					redactAuthorizationHeader(err, token);
					throw err;
				}
			};
		},
	});
}
