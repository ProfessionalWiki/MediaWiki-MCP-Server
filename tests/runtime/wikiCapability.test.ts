import { describe, it, expect } from 'vitest';
import { checkWikiCapability } from '../../src/runtime/wikiCapability.js';
import { fakeContext } from '../helpers/fakeContext.js';

const rwWiki = {
	sitename: 'X',
	server: 'https://x',
	articlepath: '/wiki',
	scriptpath: '/w',
} as never;
const roWiki = { ...rwWiki, readOnly: true } as never;

function ctx(hasExt: boolean, wikiConfig: unknown, reachable = true) {
	return fakeContext({
		wikis: {
			getAll: () => ({ w: wikiConfig }) as never,
			get: (() => wikiConfig) as never,
			add: (() => {}) as never,
			remove: (() => {}) as never,
			isManagementAllowed: () => true,
		},
		extensions: {
			has: (async () => hasExt) as never,
			hasAny: (async () => hasExt) as never,
			invalidate: (() => {}) as never,
			inspect: (async () => ({ reachable, extensions: new Set<string>() })) as never,
		},
	});
}

describe('checkWikiCapability', () => {
	it('rejects an extension tool when the wiki lacks the extension', async () => {
		const result = await checkWikiCapability('cargo-query', 'w', ctx(false, rwWiki));
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain('not installed');
	});

	it('reports an unreachable wiki rather than claiming the extension is missing', async () => {
		const result = await checkWikiCapability('cargo-query', 'w', ctx(false, rwWiki, false));
		expect(result?.isError).toBe(true);
		const text = JSON.stringify(result?.content);
		expect(text).toContain('could not be reached');
		expect(text).not.toContain('not installed');
	});

	it('allows an extension tool when the wiki has the extension', async () => {
		expect(await checkWikiCapability('cargo-query', 'w', ctx(true, rwWiki))).toBeUndefined();
	});

	it('rejects a write tool against a read-only wiki', async () => {
		const result = await checkWikiCapability('update-page', 'w', ctx(true, roWiki));
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain('read-only');
	});

	it('allows a write tool against a writable wiki', async () => {
		expect(await checkWikiCapability('update-page', 'w', ctx(true, rwWiki))).toBeUndefined();
	});

	it('returns undefined for a plain read tool', async () => {
		expect(await checkWikiCapability('get-page', 'w', ctx(false, rwWiki))).toBeUndefined();
	});
});
