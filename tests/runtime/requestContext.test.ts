import { describe, it, expect } from 'vitest';
import {
	runtimeTokenStore,
	getCallerId,
	getRequestWiki,
	getRuntimeToken,
	withRequestContext,
	withRequestFields,
} from '../../src/runtime/requestContext.ts';

describe('requestContext', () => {
	it('holds no token outside a run', () => {
		expect(getRuntimeToken('wiki-a')).toBeUndefined();
	});

	it('holds no token when the context sets none', () => {
		runtimeTokenStore.run({}, () => {
			expect(getRuntimeToken('wiki-a')).toBeUndefined();
		});
	});

	it('inner run overrides outer token', () => {
		runtimeTokenStore.run({ runtimeToken: { value: 'outer', wikiKey: null } }, () => {
			expect(getRuntimeToken('wiki-a')).toBe('outer');
			runtimeTokenStore.run({ runtimeToken: { value: 'inner', wikiKey: null } }, () => {
				expect(getRuntimeToken('wiki-a')).toBe('inner');
			});
			expect(getRuntimeToken('wiki-a')).toBe('outer');
		});
	});

	it('isolates concurrent runs', async () => {
		const results: string[] = [];

		await Promise.all([
			runtimeTokenStore.run({ runtimeToken: { value: 'token-a', wikiKey: null } }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(`a:${getRuntimeToken('wiki-a')}`);
			}),
			runtimeTokenStore.run({ runtimeToken: { value: 'token-b', wikiKey: null } }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`b:${getRuntimeToken('wiki-a')}`);
			}),
		]);

		expect(results).toContain('a:token-a');
		expect(results).toContain('b:token-b');
	});
});

describe('a runtime token', () => {
	it('is given to the wiki it was issued for', () => {
		runtimeTokenStore.run({ runtimeToken: { value: 'abc', wikiKey: 'wiki-a' } }, () => {
			expect(getRuntimeToken('wiki-a')).toBe('abc');
		});
	});

	it('is withheld from any other wiki', () => {
		runtimeTokenStore.run({ runtimeToken: { value: 'abc', wikiKey: 'wiki-a' } }, () => {
			expect(getRuntimeToken('wiki-b')).toBeUndefined();
		});
	});

	it('is given to every wiki when the caller forwarded it', () => {
		runtimeTokenStore.run({ runtimeToken: { value: 'abc', wikiKey: null } }, () => {
			expect(getRuntimeToken('wiki-b')).toBe('abc');
		});
	});
});

describe('the caller id', () => {
	it('is a digest of the token, whichever wiki it was issued for', () => {
		runtimeTokenStore.run({ runtimeToken: { value: 'abc', wikiKey: 'wiki-a' } }, () => {
			expect(getCallerId()).toMatch(/^sha256:[0-9a-f]{12}$/);
		});
	});

	it('is anonymous without a token', () => {
		expect(getCallerId()).toBe('anonymous');
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
		await withRequestContext({ value: 'tok', wikiKey: null }, async () => {
			await withRequestFields({ wikiKey: 'de.wikipedia.org' }, async () => {
				expect(getRequestWiki()).toBe('de.wikipedia.org');
				expect(getRuntimeToken('de.wikipedia.org')).toBe('tok');
			});
		});
	});

	it('a later withRequestFields preserves wikiKey while adding a token', async () => {
		await withRequestFields({ wikiKey: 'es.wikipedia.org' }, async () => {
			await withRequestFields(
				{ runtimeToken: { value: 'bearer-xyz', wikiKey: null } },
				async () => {
					expect(getRequestWiki()).toBe('es.wikipedia.org');
					expect(getRuntimeToken('es.wikipedia.org')).toBe('bearer-xyz');
				},
			);
		});
	});
});
