import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { RegisteredTool } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import type { WikiProbe } from '../../src/wikis/wikiProbe.ts';
import { reconcileTools } from '../../src/runtime/reconcile.ts';
import { extensionPacks } from '../../src/tools/extensions/index.ts';
import { registerAllTools } from '../../src/tools/index.ts';
import { fakeContext } from '../helpers/fakeContext.ts';

const wikiA: WikiConfig = {
	sitename: 'Writeable',
	server: 'https://a.example',
	articlepath: '/wiki',
	scriptpath: '/w',
	readOnly: false,
};

const wikiB: WikiConfig = {
	sitename: 'Read Only',
	server: 'https://b.example',
	articlepath: '/wiki',
	scriptpath: '/w',
	readOnly: true,
};

const wikiStore: { current: WikiConfig; byKey: Record<string, WikiConfig> } = {
	current: wikiA,
	byKey: { a: wikiA, b: wikiB },
};

const isManagementAllowedRef = { current: true };

const WRITE_TOOLS = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url',
	'update-file',
	'update-file-from-url',
];

function currentKey(): string {
	return Object.keys(wikiStore.byKey).find((k) => wikiStore.byKey[k] === wikiStore.current) ?? 'a';
}

async function connectClientAndServer(): Promise<{ client: Client; server: McpServer }> {
	const server = new McpServer(
		{ name: 'test', version: '0.0.0' },
		{ capabilities: { tools: { listChanged: true } } },
	);
	const tools = new Map<string, RegisteredTool>();
	const wikiRegistryMock = {
		getAll: () => wikiStore.byKey,
		get: (key: string) => wikiStore.byKey[key],
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => isManagementAllowedRef.current,
	};
	const activeWikiMock = {
		get: () => ({ key: currentKey(), config: wikiStore.current }),
		getDefaultKey: () => currentKey(),
	};
	const fakeProbe: WikiProbe = {
		hasExtension: vi.fn(async () => false),
		hasAnyExtension: vi.fn(async () => false),
		inspect: vi.fn(async () => ({ reachable: true, extensions: new Set<string>() })),
		invalidate: vi.fn(),
	};
	const reconcile = () =>
		reconcileTools(tools, {
			wikiRegistry: wikiRegistryMock,
			transport: 'stdio',
			wikiProbe: fakeProbe,
			extensionPacks,
		});
	const ctx = fakeContext({
		wikis: wikiRegistryMock,
		activeWiki: activeWikiMock,
	});
	const registered = registerAllTools(server, reconcile, ctx);
	for (const [name, tool] of registered) {
		tools.set(name, tool);
	}
	await reconcile();

	const client = new Client({ name: 'test-client', version: '0.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe('registerAllTools — wiki management gating', () => {
	beforeEach(() => {
		wikiStore.current = wikiA;
	});

	it('lists add-wiki and remove-wiki when wiki management is allowed', async () => {
		isManagementAllowedRef.current = true;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		expect(names).toContain('add-wiki');
		expect(names).toContain('remove-wiki');
		expect(names).toContain('get-page');
	});

	it('omits add-wiki and remove-wiki when management is disallowed and 2+ wikis are configured', async () => {
		isManagementAllowedRef.current = false;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		expect(names).not.toContain('add-wiki');
		expect(names).not.toContain('remove-wiki');
		expect(names).toContain('get-page');
	});

	it('hides add-wiki and remove-wiki on the hosted single-wiki shape (1 wiki + management disallowed)', async () => {
		isManagementAllowedRef.current = false;
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { a: wikiA };
		try {
			const { client } = await connectClientAndServer();

			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);

			expect(names).not.toContain('add-wiki');
			expect(names).not.toContain('remove-wiki');
			expect(names).toContain('get-page');
		} finally {
			wikiStore.byKey = originalByKey;
		}
	});

	// A disabled tool is absent from tools/list, so this path is only reached by a
	// client calling from a stale list. The SDK rejects such a call at the protocol
	// layer rather than resolving an isError result.
	it('rejects calls to add-wiki with a disabled error when wiki management is disallowed', async () => {
		isManagementAllowedRef.current = false;
		const { client } = await connectClientAndServer();

		await expect(
			client.callTool({
				name: 'add-wiki',
				arguments: { wikiUrl: 'https://en.wikipedia.org' },
			}),
		).rejects.toThrow(/Tool add-wiki disabled/);
	});

	it('shows remove-wiki when 2 wikis are configured and management is allowed', async () => {
		isManagementAllowedRef.current = true;
		const { client } = await connectClientAndServer();

		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain('remove-wiki');
		expect(names).toContain('add-wiki');
	});

	it('hides remove-wiki when only 1 wiki is configured and management is allowed', async () => {
		isManagementAllowedRef.current = true;
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { a: wikiA };
		try {
			const { client } = await connectClientAndServer();

			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).not.toContain('remove-wiki');
			expect(names).toContain('add-wiki');
		} finally {
			wikiStore.byKey = originalByKey;
		}
	});
});

describe('registerAllTools — per-wiki readOnly', () => {
	beforeEach(() => {
		isManagementAllowedRef.current = true;
		wikiStore.current = wikiA;
	});

	it('includes write tools when the default wiki is writeable', async () => {
		wikiStore.current = wikiA;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		for (const w of WRITE_TOOLS) {
			expect(names).toContain(w);
		}
	});

	it('keeps write tools listed when only a non-default wiki is writeable', async () => {
		// Union gating: write tools stay offered while ANY configured wiki is
		// writeable, even if the default wiki is read-only.
		wikiStore.current = wikiB;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		for (const w of WRITE_TOOLS) {
			expect(names).toContain(w);
		}
		expect(names).toContain('get-page');
	});

	it('omits write tools when every configured wiki is readOnly', async () => {
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { b: wikiB };
		wikiStore.current = wikiB;
		try {
			const { client } = await connectClientAndServer();

			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);

			for (const w of WRITE_TOOLS) {
				expect(names).not.toContain(w);
			}
			expect(names).toContain('get-page');
		} finally {
			wikiStore.byKey = originalByKey;
		}
	});

	it('rejects a write tool call with a disabled error when every configured wiki is readOnly', async () => {
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { b: wikiB };
		wikiStore.current = wikiB;
		try {
			const { client } = await connectClientAndServer();

			await expect(
				client.callTool({
					name: 'create-page',
					arguments: { title: 'Test', source: 'test' },
				}),
			).rejects.toThrow(/Tool create-page disabled/);
		} finally {
			wikiStore.byKey = originalByKey;
		}
	});
});
