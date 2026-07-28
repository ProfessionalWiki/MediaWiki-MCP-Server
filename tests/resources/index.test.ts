import { describe, it, expect, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
	createMcpHandler,
	InMemoryServerEventBus,
	McpServer,
	ResourceNotFoundError,
} from '@modelcontextprotocol/server';
import type { ResourceTemplate } from '@modelcontextprotocol/server';
import { registerAllResources } from '../../src/resources/index.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import type { SiteInfo } from '../../src/wikis/siteInfoCache.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

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

type ReadHandler = (
	uri: { toString: () => string },
	vars: { wikiKey: string },
) => Promise<{
	contents: Array<{ text: string }>;
}>;

function captureResource(ctx: ReturnType<typeof fakeContext>) {
	let handler!: ReadHandler;
	let template!: ResourceTemplate;
	const fakeServer = {
		registerResource: (_name: string, t: ResourceTemplate, _config: unknown, h: ReadHandler) => {
			template = t;
			handler = h;
		},
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal McpServer double for resource registration
	registerAllResources(fakeServer as never, ctx);
	return { handler, template };
}

function captureHandler(ctx: ReturnType<typeof fakeContext>): ReadHandler {
	return captureResource(ctx).handler;
}

// registerAllResources always supplies a list callback, and that callback
// ignores the server context it is handed.
async function listedUris(template: ResourceTemplate): Promise<string[]> {
	// oxlint-disable-next-line typescript/no-non-null-assertion -- see above
	const listed = await template.listCallback!({} as never);
	return listed.resources.map((resource) => resource.uri);
}

// A context whose registry holds exactly the given keys, so a test can name a
// key the shared fakeContext registry does not carry.
function ctxWithWikis(keys: string[]) {
	const config: WikiConfig = {
		sitename: 'Test',
		server: 'https://test.wiki',
		articlepath: '/wiki',
		scriptpath: '/w',
	};
	const registry: Record<string, WikiConfig> = {};
	for (const key of keys) {
		registry[key] = config;
	}
	return fakeContext({
		mwn: async () =>
			createMockMwn({ request: vi.fn().mockRejectedValue(new Error('down')) }) as never,
		siteInfoCache: emptyCache() as never,
		wikis: {
			getAll: () => registry as never,
			get: ((key: string) => (Object.hasOwn(registry, key) ? registry[key] : undefined)) as never,
			add: vi.fn() as never,
			remove: vi.fn() as never,
			isManagementAllowed: () => false,
		},
	});
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

	// Every credential and server-side setting at once: the published body is an
	// allowlist, so a field added to WikiConfig later cannot leak by default.
	it('publishes only the public fields, never credentials or operational settings', async () => {
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(new Error('down')) });
		const loaded = {
			sitename: 'Secretive',
			server: 'https://internal.svc',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: 'SECRET-OAUTH1-TOKEN',
			username: 'SECRET-BOT-USER',
			password: 'SECRET-BOT-PASSWORD',
			oauth2ClientId: 'SECRET-CLIENT-ID',
			oauth2ClientSecret: 'SECRET-CLIENT-SECRET',
			publicServer: 'https://public.example',
			oauth2CallbackPort: 33418,
			private: true,
			readOnly: true,
			tags: 'mcp-edit',
			attributeEdits: false,
		};
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: emptyCache() as never,
			wikis: {
				getAll: () => ({ 'test-wiki': loaded }) as never,
				get: ((key: string) => (key === 'test-wiki' ? loaded : undefined)) as never,
				add: vi.fn() as never,
				remove: vi.fn() as never,
				isManagementAllowed: () => false,
			},
		});
		const handler = captureHandler(ctx);

		const result = await handler(
			{ toString: () => 'mcp://wikis/test-wiki' },
			{ wikiKey: 'test-wiki' },
		);
		const text = result.contents[0].text;
		const payload = JSON.parse(text) as Record<string, unknown>;

		// No secret value appears anywhere in the serialized body.
		for (const secret of [
			'SECRET-OAUTH1-TOKEN',
			'SECRET-BOT-USER',
			'SECRET-BOT-PASSWORD',
			'SECRET-CLIENT-ID',
			'SECRET-CLIENT-SECRET',
		]) {
			expect(text).not.toContain(secret);
		}

		// The published key set is exactly the documented contract.
		expect(Object.keys(payload).sort()).toEqual(
			['articlepath', 'private', 'readOnly', 'scriptpath', 'server', 'sitename'].sort(),
		);
		expect(payload.sitename).toBe('Secretive');
		expect(payload.private).toBe(true);
		expect(payload.readOnly).toBe(true);
	});

	it('rejects an unknown wiki with a resource-not-found error', async () => {
		const handler = captureHandler(ctxWithWikis(['test-wiki']));

		const error: unknown = await handler(
			{ toString: () => 'mcp://wikis/typo-wiki' },
			{ wikiKey: 'typo-wiki' },
		).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(ResourceNotFoundError.isInstance(error)).toBe(true);
		expect((error as ResourceNotFoundError).code).toBe(-32602);
		expect((error as ResourceNotFoundError).data).toEqual({ uri: 'mcp://wikis/typo-wiki' });
	});

	it('carries the not-found error to the client as -32602 over the stateless HTTP path', async () => {
		const bus = new InMemoryServerEventBus();
		const handler = createMcpHandler(
			() => {
				const server = new McpServer(
					{ name: 'resource-conformance-test', version: '0.0.0' },
					{ capabilities: { resources: { listChanged: true } } },
				);
				registerAllResources(server, ctxWithWikis(['test-wiki']));
				return Promise.resolve(server);
			},
			{ legacy: 'stateless', bus },
		);
		const client = new Client({ name: 'resource-conformance-test', version: '0.0.0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL('http://in-memory.test/mcp'), {
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		);

		try {
			const error: unknown = await client.readResource({ uri: 'mcp://wikis/typo-wiki' }).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect((error as { code?: number }).code).toBe(-32602);
			expect((error as { data?: unknown }).data).toEqual({ uri: 'mcp://wikis/typo-wiki' });
		} finally {
			await client.close();
			await handler.close();
		}
	});

	it('round-trips a wiki key that needs percent-encoding from the listing to a read', async () => {
		const { handler, template } = captureResource(ctxWithWikis(['my wiki spaced']));

		const [uri] = await listedUris(template);
		expect(uri).toBe('mcp://wikis/my%20wiki%20spaced');

		const matched = template.uriTemplate.match(uri);
		expect(matched).toEqual({ wikiKey: 'my%20wiki%20spaced' });

		const result = await handler({ toString: () => uri }, { wikiKey: 'my%20wiki%20spaced' });
		expect(JSON.parse(result.contents[0].text)).toMatchObject({ sitename: 'Test' });
	});

	it('leaves a host:port key unencoded, as RFC 3986 permits ":" in a path segment', async () => {
		const { template } = captureResource(ctxWithWikis(['localhost:8080']));

		expect(await listedUris(template)).toEqual(['mcp://wikis/localhost:8080']);
	});

	it('rejects a URI whose key is not valid percent-encoding', async () => {
		// A client that sends the "100%" key unescaped: decodeURIComponent throws
		// URIError on the stray "%", which must not surface as an internal error.
		const handler = captureHandler(ctxWithWikis(['100%']));

		const error: unknown = await handler(
			{ toString: () => 'mcp://wikis/100%' },
			{ wikiKey: '100%' },
		).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(ResourceNotFoundError.isInstance(error)).toBe(true);
		expect((error as ResourceNotFoundError).data).toEqual({ uri: 'mcp://wikis/100%' });
	});

	it('reads the "100%" wiki through its encoded URI', async () => {
		const { handler, template } = captureResource(ctxWithWikis(['100%']));

		expect(await listedUris(template)).toEqual(['mcp://wikis/100%25']);

		const result = await handler({ toString: () => 'mcp://wikis/100%25' }, { wikiKey: '100%25' });
		expect(JSON.parse(result.contents[0].text)).toMatchObject({ sitename: 'Test' });
	});
});
