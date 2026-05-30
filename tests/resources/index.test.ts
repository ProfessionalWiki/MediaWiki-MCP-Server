import { describe, it, expect, vi } from 'vitest';
import { registerAllResources } from '../../src/resources/index.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import type { SiteInfo } from '../../src/wikis/siteInfoCache.js';

function emptyCache() {
	const map = new Map<string, SiteInfo>();
	return {
		get: (k: string) => map.get(k),
		set: (k: string, v: SiteInfo) => {
			map.set(k, v);
		},
		delete: (k: string) => {
			map.delete(k);
		},
	};
}

function captureHandler(ctx: ReturnType<typeof fakeContext>) {
	let handler!: (
		uri: { toString: () => string },
		vars: { wikiKey: string },
	) => Promise<{
		contents: Array<{ text: string }>;
	}>;
	const fakeServer = {
		resource: (_name: string, _template: unknown, h: typeof handler) => {
			handler = h;
		},
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal McpServer double for resource registration
	registerAllResources(fakeServer as never, ctx);
	return handler;
}

describe('wikis resource', () => {
	it('exposes the public server and license from siteinfo', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					general: { server: 'https://public.example', articlepath: '/wiki/$1' },
					rightsinfo: { url: 'https://example.org/license', text: 'Example License' },
				},
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});
		const handler = captureHandler(ctx);

		const result = await handler(
			{ toString: () => 'mcp://wikis/test-wiki' },
			{ wikiKey: 'test-wiki' },
		);
		const payload = JSON.parse(result.contents[0].text) as Record<string, unknown>;

		expect(payload.server).toBe('https://public.example');
		expect(payload.articlepath).toBe('/wiki');
		expect(payload.license).toEqual({
			url: 'https://example.org/license',
			title: 'Example License',
		});
	});

	it('falls back to the configured server and omits license when siteinfo is unavailable', async () => {
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(new Error('down')) });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
		});
		const handler = captureHandler(ctx);

		const result = await handler(
			{ toString: () => 'mcp://wikis/test-wiki' },
			{ wikiKey: 'test-wiki' },
		);
		const payload = JSON.parse(result.contents[0].text) as Record<string, unknown>;

		expect(payload.server).toBe('https://test.wiki');
		expect(payload.license).toBeUndefined();
	});
});
