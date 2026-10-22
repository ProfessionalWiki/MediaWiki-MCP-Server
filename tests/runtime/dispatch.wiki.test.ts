import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import type { Tool } from '../../src/runtime/tool.ts';
import type { SharedContext } from '../../src/runtime/context.ts';
import type { Mwn } from 'mwn';
import { fakeContext } from '../helpers/fakeContext.ts';
import { writingWiki } from '../helpers/writingWiki.ts';
import { createSharedContext } from '../../src/runtime/createContext.ts';
import { createAppState } from '../../src/wikis/state.ts';
import type { MwnProvider } from '../../src/wikis/mwnProvider.ts';
import { logger } from '../../src/runtime/logger.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { updatePage } from '../../src/tools/update-page.ts';
import { getPage } from '../../src/tools/get-page.ts';
import { cargoQuery } from '../../src/tools/extensions/cargo/cargo-query.ts';
import { fakeAuthPolicy } from '../helpers/fakeAuthPolicy.ts';

// A minimal wiki-scoped tool that reports the wiki it ran against.
const probe: Tool<Record<string, never>> = {
	name: 'probe',
	description: 'test probe',
	inputSchema: {},
	annotations: {} as never,
	async handle(_args, ctx): Promise<CallToolResult> {
		return ctx.format.ok({ ranAgainst: ctx.wiki.key });
	},
};

function ranAgainst(result: CallToolResult): unknown {
	return (result.structuredContent as { ranAgainst?: unknown }).ranAgainst;
}

describe('dispatch wiki resolution', () => {
	it('runs against the wiki named in the wiki argument', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'fr.wikipedia.org' } as never);
		expect(ranAgainst(result)).toBe('fr.wikipedia.org');
	});

	it('runs against the default wiki when wiki is omitted', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({} as never);
		expect(ranAgainst(result)).toBe('test-wiki');
	});

	it('accepts an mcp://wikis/ URI', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'mcp://wikis/fr.wikipedia.org' } as never);
		expect(ranAgainst(result)).toBe('fr.wikipedia.org');
	});

	it('returns invalid_input for an unknown wiki', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'nope.example' } as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('not found');
	});

	it('rejects prototype-chain keys with a not-found error', async () => {
		const ctx = fakeContext();
		for (const key of ['constructor', '__proto__', 'toString']) {
			const result = await dispatch(probe, ctx)({ wiki: key } as never);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain('not found');
		}
	});

	it('falls back to the default wiki for a bare mcp://wikis/ prefix', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'mcp://wikis/' } as never);
		expect(ranAgainst(result)).toBe('test-wiki');
	});

	it('falls back to the default wiki for a whitespace-only wiki argument', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: '   ' } as never);
		expect(ranAgainst(result)).toBe('test-wiki');
	});

	it('isolates concurrent calls targeting different wikis', async () => {
		const ctx = fakeContext();
		// A tool that yields to a real macrotask before reading its wiki, so both
		// dispatches are suspended at the timer at the same time — a context
		// shared between calls would surface here.
		const slowProbe: Tool<Record<string, never>> = {
			name: 'slow-probe',
			description: 'test probe that yields before reading the wiki',
			inputSchema: {},
			annotations: {} as never,
			async handle(_args, ctx): Promise<CallToolResult> {
				await new Promise((r) => setTimeout(r, 0));
				return ctx.format.ok({ ranAgainst: ctx.wiki.key });
			},
		};
		const [a, b] = await Promise.all([
			dispatch(slowProbe, ctx)({ wiki: 'fr.wikipedia.org' } as never),
			dispatch(slowProbe, ctx)({ wiki: 'de.wikipedia.org' } as never),
		]);
		expect(ranAgainst(a)).toBe('fr.wikipedia.org');
		expect(ranAgainst(b)).toBe('de.wikipedia.org');
	});

	it('writes to the wiki the call names, with its tags', async () => {
		const site = (tags: string): WikiConfig => ({
			sitename: 'S',
			server: 'https://s.test',
			articlepath: '/wiki',
			scriptpath: '/w',
			tags,
		});
		const main = writingWiki({ edit: { result: 'Success' } });
		const other = writingWiki({ edit: { result: 'Success' } });
		const reachable: Record<string, Mwn> = { main: main.mwn, other: other.mwn };
		const mwnProvider: MwnProvider = {
			get: async (key) => reachable[key],
			invalidate: () => {},
		};
		const state = {
			...createAppState({
				defaultWiki: 'main',
				wikis: { main: site('main-tag'), other: site('other-tag') },
				uploadDirs: [],
			}),
			mwnProvider,
		};
		const writing: Tool<Record<string, never>> = {
			...probe,
			async handle(_args, c): Promise<CallToolResult> {
				await c.edit.submit(await c.mwn(), { action: 'edit', title: 'X', text: 'y' });
				return c.format.ok({});
			},
		};

		await dispatch(
			writing,
			createSharedContext({
				logger,
				state,
				auth: fakeAuthPolicy(),
			}),
		)({
			wiki: 'other',
		} as never);

		expect(other.sentWrite().get('tags')).toBe('other-tag');
		expect(main.writes).toHaveLength(0);
	});
});

describe('dispatch wiki echo', () => {
	it('stamps the resolved wiki onto a wiki-scoped success result', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'fr.wikipedia.org' } as never);
		expect((result.structuredContent as { wiki?: unknown }).wiki).toBe('fr.wikipedia.org');
	});

	it('does not stamp wiki onto a non-wiki-scoped tool', async () => {
		const ctx = fakeContext();
		const mgmt: Tool<Record<string, never>, SharedContext> = {
			name: 'mgmt-probe',
			description: 'non wiki tool',
			inputSchema: {},
			annotations: {} as never,
			wikiScoped: false,
			async handle(_args, c) {
				return c.format.ok({ ok: true });
			},
		};
		const result = await dispatch(mgmt, ctx)({} as never);
		expect((result.structuredContent as { wiki?: unknown }).wiki).toBeUndefined();
	});
});

describe('dispatch capability guard', () => {
	it('blocks a write tool dispatched against a read-only wiki', async () => {
		const roConfig = {
			sitename: 'T',
			server: 'https://t',
			articlepath: '/wiki',
			scriptpath: '/w',
			readOnly: true,
		};
		const ctx = fakeContext({
			wikis: {
				getAll: () => ({ 'test-wiki': roConfig }) as never,
				get: ((k: string) => (k === 'test-wiki' ? roConfig : undefined)) as never,
				add: (() => {}) as never,
				remove: (() => {}) as never,
				isManagementAllowed: () => true,
			},
			defaultWikiKey: 'test-wiki',
		});
		const result = await dispatch(updatePage, ctx)({ title: 'X', source: 'y' } as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('read-only');
	});

	it('judges a write by the wiki the call resolved, though it is removed while the call runs', async () => {
		const roConfig = {
			sitename: 'T',
			server: 'https://t',
			articlepath: '/wiki',
			scriptpath: '/w',
			readOnly: true,
		};
		let lookups = 0;
		const ctx = fakeContext({
			wikis: {
				getAll: () => ({}) as never,
				// Answers the call's own lookup, then reads as removed.
				get: ((k: string) =>
					k === 'test-wiki' && lookups++ === 0 ? roConfig : undefined) as never,
				add: (() => {}) as never,
				remove: (() => {}) as never,
				isManagementAllowed: () => true,
			},
			defaultWikiKey: 'test-wiki',
		});

		const result = await dispatch(updatePage, ctx)({ title: 'X', source: 'y' } as never);

		expect(JSON.stringify(result.content)).toContain('read-only');
	});

	it('blocks an extension tool dispatched against a wiki lacking the extension', async () => {
		const config = {
			sitename: 'T',
			server: 'https://t',
			articlepath: '/wiki',
			scriptpath: '/w',
		};
		const ctx = fakeContext({
			wikis: {
				getAll: () => ({ 'test-wiki': config }) as never,
				get: ((k: string) => (k === 'test-wiki' ? config : undefined)) as never,
				add: (() => {}) as never,
				remove: (() => {}) as never,
				isManagementAllowed: () => true,
			},
			defaultWikiKey: 'test-wiki',
			wikiProbe: {
				inspect: (async () => ({ reachable: true, extensions: new Set() })) as never,
				invalidate: (() => {}) as never,
			},
		});
		// The guard fires before the handler, so the only possible failure here
		// is the capability guard's "not installed" — not a schema/handler error.
		const result = await dispatch(cargoQuery, ctx)({ tables: 'Items' } as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('not installed');
	});

	it('blocks an HTTP call to an OAuth-only wiki with no usable token', async () => {
		const oauthConfig = {
			sitename: 'T',
			server: 'https://t',
			articlepath: '/wiki',
			scriptpath: '/w',
			oauth2ClientId: 'client-id',
		};
		const ctx = fakeContext({
			auth: fakeAuthPolicy({ transport: 'http' }),
			wikis: {
				getAll: () => ({ 'test-wiki': oauthConfig }) as never,
				get: ((k: string) => (k === 'test-wiki' ? oauthConfig : undefined)) as never,
				add: (() => {}) as never,
				remove: (() => {}) as never,
				isManagementAllowed: () => true,
			},
			defaultWikiKey: 'test-wiki',
		});
		const result = await dispatch(getPage, ctx)({ title: 'X' } as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('requires an authenticated user');
	});
});
