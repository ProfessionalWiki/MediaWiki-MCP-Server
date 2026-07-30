import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryServerEventBus } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createServer, type ChangePublisher } from '../../src/server.ts';
import { fakeContext } from '../helpers/fakeContext.ts';

// Drives the era-routing handler in memory, exactly as buildApp wires it: the
// same per-request createServer factory, the same publisher-over-notify shape.
// The express route composition in front of it is covered by mcpRoute.test.ts.
function buildHandler(ctx = fakeContext()): {
	handler: McpHttpHandler;
	bus: InMemoryServerEventBus;
} {
	const bus = new InMemoryServerEventBus();
	const publisher: ChangePublisher = {
		toolsChanged: () => handler.notify.toolsChanged(),
		resourcesChanged: () => handler.notify.resourcesChanged(),
	};
	const handler = createMcpHandler(() => createServer(ctx, { publisher }), {
		legacy: 'stateless',
		bus,
	});
	return { handler, bus };
}

function clientTransport(handler: McpHttpHandler): StreamableHTTPClientTransport {
	return new StreamableHTTPClientTransport(new URL('http://in-memory.test/mcp'), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});
}

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	tags: null,
};

describe('2026-07-28 era over Streamable HTTP (in-memory)', () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) {
			await cleanup();
		}
	});

	it('negotiates the modern era when pinned to 2026-07-28 and round-trips a tool call', async () => {
		const ctx = fakeContext({
			wikiProbe: {
				hasExtension: (async () => false) as never,
				hasAnyExtension: (async () => true) as never,
				inspect: (async () => ({
					reachable: true,
					extensions: new Set<string>(),
					server: 'https://test.wiki',
				})) as never,
				invalidate: (() => {}) as never,
			},
		});
		const { handler } = buildHandler(ctx);
		cleanups.push(() => handler.close());

		const client = new Client(
			{ name: 'modern-era-test', version: '0.0.0' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
		);
		cleanups.push(() => client.close());
		await client.connect(clientTransport(handler));

		expect(client.getProtocolEra()).toBe('modern');
		expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

		const tools = await client.listTools();
		expect(tools.tools.length).toBeGreaterThan(0);

		const result = await client.callTool({
			name: 'list-wikis',
			arguments: {},
		});
		expect(result.isError ?? false).toBe(false);
	});

	it('falls back to a legacy handshake through the same handler when negotiation is off', async () => {
		const { handler } = buildHandler();
		cleanups.push(() => handler.close());

		const client = new Client({ name: 'legacy-era-test', version: '0.0.0' });
		cleanups.push(() => client.close());
		await client.connect(clientTransport(handler));

		const tools = await client.listTools();
		expect(tools.tools.length).toBeGreaterThan(0);
	});

	it('delivers toolsChanged to a modern listen subscriber when a management tool reconciles', async () => {
		const wikis: Record<string, typeof wikiConfig> = {
			'test-wiki': wikiConfig,
			'fr.wikipedia.org': wikiConfig,
			'de.wikipedia.org': wikiConfig,
		};
		const ctx = fakeContext({
			wikis: {
				getAll: () => wikis as never,
				get: ((key: string) => (Object.hasOwn(wikis, key) ? wikis[key] : undefined)) as never,
				add: vi.fn() as never,
				remove: ((key: string) => {
					delete wikis[key];
				}) as never,
				isManagementAllowed: () => true,
			},
			wikiCache: { invalidate: vi.fn() as never },
		});
		const { handler, bus } = buildHandler(ctx);
		cleanups.push(() => handler.close());

		// Bus-level subscriber: the ground truth that a change event reached the
		// subscriptions/listen seam.
		const seen: string[] = [];
		const unsubscribe = bus.subscribe((event) => {
			seen.push(event.kind);
		});
		cleanups.push(async () => unsubscribe());

		const client = new Client(
			{ name: 'listen-test', version: '0.0.0' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
		);
		cleanups.push(() => client.close());
		await client.connect(clientTransport(handler));

		const result = await client.callTool({
			name: 'remove-wiki',
			arguments: { uri: 'mcp://wikis/fr.wikipedia.org' },
		});
		expect(result.isError ?? false).toBe(false);

		expect(seen).toContain('tools_list_changed');
		expect(seen).toContain('resources_list_changed');
	});

	it('serves a real subscriptions/listen stream: gauge invariant, delivery, graceful close', async () => {
		const wikis: Record<string, typeof wikiConfig> = {
			'test-wiki': wikiConfig,
			'fr.wikipedia.org': wikiConfig,
			'de.wikipedia.org': wikiConfig,
		};
		const ctx = fakeContext({
			wikis: {
				getAll: () => wikis as never,
				get: ((key: string) => (Object.hasOwn(wikis, key) ? wikis[key] : undefined)) as never,
				add: vi.fn() as never,
				remove: ((key: string) => {
					delete wikis[key];
				}) as never,
				isManagementAllowed: () => true,
			},
			wikiCache: { invalidate: vi.fn() as never },
		});
		const { handler, bus } = buildHandler(ctx);
		cleanups.push(() => handler.close());

		const changed: Array<{ error: unknown; count: number | null }> = [];
		const client = new Client(
			{ name: 'listen-stream-test', version: '0.0.0' },
			{
				versionNegotiation: { mode: { pin: '2026-07-28' } },
				listChanged: {
					tools: {
						onChanged: (error, tools) => {
							changed.push({ error, count: tools ? tools.length : null });
						},
					},
				},
			},
		);
		cleanups.push(() => client.close());

		expect(bus.listenerCount).toBe(0);
		await client.connect(clientTransport(handler));
		// The listChanged option auto-opens the subscriptions/listen stream on a
		// modern connection; each open stream registers exactly one bus
		// listener, which is the invariant the mcp_subscription_streams gauge
		// reads.
		const subscription = client.autoOpenedSubscription;
		expect(subscription).toBeDefined();
		expect(bus.listenerCount).toBe(1);

		const result = await client.callTool({
			name: 'remove-wiki',
			arguments: { uri: 'mcp://wikis/fr.wikipedia.org' },
		});
		expect(result.isError ?? false).toBe(false);
		// The change event must arrive over the held-open stream, not just the bus.
		await vi.waitFor(() => {
			expect(changed.length).toBeGreaterThan(0);
		});
		expect(changed[0].error).toBeFalsy();

		// A deliberate server close ends the stream with the spec's graceful
		// empty result, and the gauge returns to zero.
		await handler.close();
		await expect(subscription!.closed).resolves.toBe('graceful');
		expect(bus.listenerCount).toBe(0);
	});
});
