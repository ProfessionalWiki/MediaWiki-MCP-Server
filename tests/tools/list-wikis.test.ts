import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { listWikis } from '../../src/tools/list-wikis.js';
import { fakeContext } from '../helpers/fakeContext.js';

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
} as never;

function ctxWith(extByWiki: Record<string, Set<string>>, unreachable: Set<string> = new Set()) {
	const wikis = { 'test-wiki': wikiConfig, 'cargo.wiki': wikiConfig };
	return fakeContext({
		wikis: {
			getAll: () => wikis as never,
			get: ((k: string) =>
				Object.hasOwn(wikis, k) ? wikis[k as keyof typeof wikis] : undefined) as never,
			add: (() => {}) as never,
			remove: (() => {}) as never,
			isManagementAllowed: () => true,
		},
		activeWiki: {
			get: () => ({ key: 'test-wiki', config: wikiConfig }),
			getDefaultKey: () => 'test-wiki',
		},
		extensions: {
			has: (async () => false) as never,
			hasAny: (async () => false) as never,
			invalidate: (() => {}) as never,
			inspect: (async (k: string) => ({
				reachable: !unreachable.has(k),
				extensions: extByWiki[k] ?? new Set<string>(),
			})) as never,
		},
	});
}

function wikisOf(result: CallToolResult): Array<Record<string, unknown>> {
	return (result.structuredContent as { wikis: Array<Record<string, unknown>> }).wikis;
}

describe('list-wikis', () => {
	it('returns every configured wiki with key, isDefault, readOnly, reachable', async () => {
		const ctx = ctxWith({});
		const result = await dispatch(listWikis, ctx)({} as never);
		const wikis = wikisOf(result);
		expect(wikis.map((w) => w.key).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
			'cargo.wiki',
			'test-wiki',
		]);
		const def = wikis.find((w) => w.key === 'test-wiki')!;
		expect(def.isDefault).toBe(true);
		expect(wikis.find((w) => w.key === 'cargo.wiki')!.isDefault).toBe(false);
		expect(def.reachable).toBe(true);
		expect(def).toMatchObject({ sitename: 'Test', server: 'https://test.wiki' });
	});

	it('lists the extension tools of packs the wiki has', async () => {
		const ctx = ctxWith({ 'cargo.wiki': new Set(['Cargo']) });
		const result = await dispatch(listWikis, ctx)({} as never);
		const cargo = wikisOf(result).find((w) => w.key === 'cargo.wiki')!;
		expect(cargo.extensionTools).toContain('cargo-query');
		const def = wikisOf(result).find((w) => w.key === 'test-wiki')!;
		expect(def.extensionTools).toEqual([]);
	});

	it('reports reachable=false with no extension tools for an unreachable wiki', async () => {
		const ctx = ctxWith({}, new Set(['cargo.wiki']));
		const result = await dispatch(listWikis, ctx)({} as never);
		const cargo = wikisOf(result).find((w) => w.key === 'cargo.wiki')!;
		expect(cargo.reachable).toBe(false);
		expect(cargo.extensionTools).toEqual([]);
	});
});
