import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { listWikis } from '../../src/tools/list-wikis.js';
import { fakeContext } from '../helpers/fakeContext.js';

const fetchMetadata = vi.fn();
vi.mock('../../src/auth/metadata.js', () => ({
	fetchMetadata: (...args: unknown[]) => fetchMetadata(...args) as unknown,
}));

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
} as never;

// Shared so every test can assert listing never resolves credentials.
const mwnSpy = vi.fn();

function ctxWith(
	extByWiki: Record<string, Set<string>>,
	unreachable: Set<string> = new Set(),
	wikis: Record<string, unknown> = { 'test-wiki': wikiConfig, 'cargo.wiki': wikiConfig },
	serverByWiki: Record<string, string> = {},
) {
	return fakeContext({
		wikis: {
			getAll: () => wikis as never,
			get: ((k: string) => (Object.hasOwn(wikis, k) ? wikis[k] : undefined)) as never,
			add: (() => {}) as never,
			remove: (() => {}) as never,
			isManagementAllowed: () => true,
		},
		activeWiki: {
			get: () => ({ key: 'test-wiki', config: wikiConfig }),
			getDefaultKey: () => 'test-wiki',
		},
		// list-wikis must never authenticate; route mwn through a spy so any
		// accidental credential resolution is caught.
		mwn: mwnSpy as never,
		wikiProbe: {
			hasExtension: (async () => false) as never,
			hasAnyExtension: (async () => false) as never,
			invalidate: (() => {}) as never,
			inspect: (async (k: string) => ({
				reachable: !unreachable.has(k),
				extensions: extByWiki[k] ?? new Set<string>(),
				...(serverByWiki[k] !== undefined ? { server: serverByWiki[k] } : {}),
			})) as never,
		},
	});
}

function wikisOf(result: CallToolResult): Array<Record<string, unknown>> {
	return (result.structuredContent as { wikis: Array<Record<string, unknown>> }).wikis;
}

describe('list-wikis', () => {
	beforeEach(() => {
		fetchMetadata.mockReset();
		mwnSpy.mockReset();
	});

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

	it('reports the authorization server issuer for an OAuth-configured wiki', async () => {
		fetchMetadata.mockResolvedValue({ issuer: 'https://oauth.wiki' });
		const ctx = ctxWith({}, new Set(), {
			'oauth-wiki': {
				sitename: 'OAuth',
				server: 'https://oauth.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'client-id-123',
			},
		});
		const result = await dispatch(listWikis, ctx)({} as never);
		const wiki = wikisOf(result).find((w) => w.key === 'oauth-wiki')!;
		expect(wiki.authorizationServer).toBe('https://oauth.wiki');
	});

	it('omits authorizationServer for a non-OAuth wiki', async () => {
		const ctx = ctxWith({}, new Set(), { 'plain-wiki': wikiConfig });
		const result = await dispatch(listWikis, ctx)({} as never);
		const wiki = wikisOf(result).find((w) => w.key === 'plain-wiki')!;
		expect(wiki).not.toHaveProperty('authorizationServer');
		expect(fetchMetadata).not.toHaveBeenCalled();
	});

	it('reports the public server from the probe, overriding the configured server', async () => {
		const ctx = ctxWith(
			{},
			new Set(),
			{ 'test-wiki': wikiConfig },
			{
				'test-wiki': 'https://public.example',
			},
		);
		const result = await dispatch(listWikis, ctx)({} as never);
		const wiki = wikisOf(result).find((w) => w.key === 'test-wiki')!;
		expect(wiki.server).toBe('https://public.example');
	});

	it('falls back to the configured server when the probe reports none', async () => {
		// serverByWiki empty → the probe omits server → config.server is used.
		const ctx = ctxWith({}, new Set(), { 'test-wiki': wikiConfig });
		const result = await dispatch(listWikis, ctx)({} as never);
		expect(wikisOf(result).find((w) => w.key === 'test-wiki')!.server).toBe('https://test.wiki');
	});

	it('lists wikis without resolving credentials — never calls ctx.mwn', async () => {
		const ctx = ctxWith({ 'cargo.wiki': new Set(['Cargo']) });
		await dispatch(listWikis, ctx)({} as never);
		expect(mwnSpy).not.toHaveBeenCalled();
	});

	it('omits authorizationServer for a wiki whose metadata fetch fails, without failing the call', async () => {
		fetchMetadata.mockImplementation((key: string) => {
			if (key === 'broken-wiki') {
				return Promise.reject(new Error('metadata unavailable'));
			}
			return Promise.resolve({ issuer: 'https://good.wiki' });
		});
		const ctx = ctxWith({}, new Set(), {
			'good-wiki': {
				sitename: 'Good',
				server: 'https://good.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'good-client',
			},
			'broken-wiki': {
				sitename: 'Broken',
				server: 'https://broken.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'broken-client',
			},
		});
		const result = await dispatch(listWikis, ctx)({} as never);
		expect(result.isError).not.toBe(true);
		const good = wikisOf(result).find((w) => w.key === 'good-wiki')!;
		const broken = wikisOf(result).find((w) => w.key === 'broken-wiki')!;
		expect(good.authorizationServer).toBe('https://good.wiki');
		expect(broken).not.toHaveProperty('authorizationServer');
	});
});
