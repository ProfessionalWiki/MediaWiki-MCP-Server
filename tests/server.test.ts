import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import { clearRegisteredServers, getRegisteredServerCount } from '../src/runtime/logger.js';
import { fakeContext } from './helpers/fakeContext.js';

afterEach(() => {
	clearRegisteredServers();
});

describe('createServer era gating', () => {
	it('registers with the logger broadcast when built without a request context', async () => {
		await createServer(fakeContext());
		expect(getRegisteredServerCount()).toBe(1);
	});

	it('registers a legacy-era instance with the logger broadcast', async () => {
		await createServer(fakeContext(), { era: 'legacy' });
		expect(getRegisteredServerCount()).toBe(1);
	});

	it('does not register a modern-era instance', async () => {
		await createServer(fakeContext(), { era: 'modern' });
		expect(getRegisteredServerCount()).toBe(0);
	});
});

const wikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	tags: null,
};

describe('createServer change publishing', () => {
	it('does not publish during construction', async () => {
		const publisher = { toolsChanged: vi.fn(), resourcesChanged: vi.fn() };
		await createServer(fakeContext(), undefined, { publisher });
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
		const server = await createServer(ctx, { era: 'legacy' }, { publisher });

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
		} finally {
			await client.close();
		}
	});
});
