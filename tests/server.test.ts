import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.ts';
import { fakeContext } from './helpers/fakeContext.ts';

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	tags: null,
};

describe('createServer capabilities', () => {
	it('does not advertise the logging capability', async () => {
		const server = await createServer(fakeContext());
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'server-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		try {
			// The positive assertion anchors the negative one: without it, a
			// capabilities object that never arrived would also pass.
			expect(client.getServerCapabilities()?.tools).toBeDefined();
			expect(client.getServerCapabilities()?.logging).toBeUndefined();
		} finally {
			await client.close();
		}
	});

	it('rejects construction when the initial gating pass fails', async () => {
		const ctx = fakeContext({
			wikiProbe: {
				hasExtension: (async () => false) as never,
				// Fails the construction-time gating pass, after tool registration.
				hasAnyExtension: (async () => {
					throw new Error('probe exploded');
				}) as never,
				inspect: (() => {}) as never,
				invalidate: (() => {}) as never,
			},
		});
		await expect(createServer(ctx)).rejects.toThrow('probe exploded');
	});
});

describe('createServer change publishing', () => {
	it('does not publish during construction', async () => {
		const publisher = { toolsChanged: vi.fn(), resourcesChanged: vi.fn() };
		await createServer(fakeContext(), { publisher });
		expect(publisher.toolsChanged).not.toHaveBeenCalled();
		expect(publisher.resourcesChanged).not.toHaveBeenCalled();
	});

	it('publishes through the supplied publisher when a management tool reconciles', async () => {
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
		const publisher = { toolsChanged: vi.fn(), resourcesChanged: vi.fn() };
		const server = await createServer(ctx, { publisher });

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'server-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
		try {
			const result = await client.callTool({
				name: 'remove-wiki',
				arguments: { uri: 'mcp://wikis/fr.wikipedia.org' },
			});
			expect(result.isError ?? false).toBe(false);
			expect(publisher.resourcesChanged).toHaveBeenCalledTimes(1);
			expect(publisher.toolsChanged).toHaveBeenCalledTimes(1);
			expect(publisher.resourcesChanged.mock.invocationCallOrder[0]).toBeLessThan(
				publisher.toolsChanged.mock.invocationCallOrder[0],
			);
		} finally {
			await client.close();
		}
	});
});
