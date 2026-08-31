import { describe, it, expect } from 'vitest';
import {
	runtimeTokenStore,
	getRequestDeadline,
	getRequestSignal,
	getRequestWiki,
	getRuntimeToken,
	withSharedWorkScope,
	withRequestContext,
	withRequestFields,
} from '../../src/runtime/requestContext.ts';
import { callDeadline } from '../../src/runtime/callDeadline.ts';

describe('requestContext', () => {
	it('returns undefined outside a run', () => {
		expect(getRuntimeToken()).toBeUndefined();
	});

	it('returns the token inside a run', () => {
		runtimeTokenStore.run({ runtimeToken: 'abc' }, () => {
			expect(getRuntimeToken()).toBe('abc');
		});
	});

	it('returns undefined when runtimeToken is not set in the context', () => {
		runtimeTokenStore.run({}, () => {
			expect(getRuntimeToken()).toBeUndefined();
		});
	});

	it('inner run overrides outer token', () => {
		runtimeTokenStore.run({ runtimeToken: 'outer' }, () => {
			expect(getRuntimeToken()).toBe('outer');
			runtimeTokenStore.run({ runtimeToken: 'inner' }, () => {
				expect(getRuntimeToken()).toBe('inner');
			});
			expect(getRuntimeToken()).toBe('outer');
		});
	});

	it('isolates concurrent runs', async () => {
		const results: string[] = [];

		await Promise.all([
			runtimeTokenStore.run({ runtimeToken: 'token-a' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(`a:${getRuntimeToken()}`);
			}),
			runtimeTokenStore.run({ runtimeToken: 'token-b' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`b:${getRuntimeToken()}`);
			}),
		]);

		expect(results).toContain('a:token-a');
		expect(results).toContain('b:token-b');
	});
});

describe('request context wiki', () => {
	it('getRequestWiki is undefined outside a context', () => {
		expect(getRequestWiki()).toBeUndefined();
	});

	it('withRequestFields exposes wikiKey to getRequestWiki', async () => {
		await withRequestFields({ wikiKey: 'fr.wikipedia.org' }, async () => {
			expect(getRequestWiki()).toBe('fr.wikipedia.org');
		});
	});

	it('withRequestFields merges onto an existing context without dropping fields', async () => {
		await withRequestContext('tok', async () => {
			await withRequestFields({ wikiKey: 'de.wikipedia.org' }, async () => {
				expect(getRequestWiki()).toBe('de.wikipedia.org');
				expect(getRuntimeToken()).toBe('tok');
			});
		});
	});

	it('a later withRequestFields preserves wikiKey while adding a token', async () => {
		await withRequestFields({ wikiKey: 'es.wikipedia.org' }, async () => {
			await withRequestFields({ runtimeToken: 'bearer-xyz' }, async () => {
				expect(getRequestWiki()).toBe('es.wikipedia.org');
				expect(getRuntimeToken()).toBe('bearer-xyz');
			});
		});
	});
});

describe('scoping work shared between callers', () => {
	it('takes neither the caller cancellation nor the caller budget', async () => {
		// The assertions live inside the callback, which might never be invoked.
		expect.assertions(3);
		const callerDeadline = callDeadline(60_000, 'calling');
		const sharedDeadline = callDeadline(60_000, 'calling');

		await withRequestFields(
			{ signal: new AbortController().signal, deadline: callerDeadline },
			async () => {
				await withSharedWorkScope(sharedDeadline, async () => {
					expect(getRequestSignal()).toBeUndefined();
					expect(getRequestDeadline()).toBe(sharedDeadline);
					expect(getRequestDeadline()).not.toBe(callerDeadline);
				});
			},
		);
	});
});
