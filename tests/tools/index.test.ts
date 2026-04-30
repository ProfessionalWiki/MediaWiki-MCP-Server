import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import type { ExtensionDetector } from '../../src/wikis/extensionDetector.js';
import { reconcileTools } from '../../src/runtime/reconcile.js';
import { registerAllTools } from '../../src/tools/index.js';
import { fakeContext } from '../helpers/fakeContext.js';

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
	const wikiSelectionMock = {
		getCurrent: () => ({ key: currentKey(), config: wikiStore.current }),
		setCurrent: (key: string) => {
			if (!wikiStore.byKey[key]) {
				throw new Error(`Wiki "${key}" not found`);
			}
			wikiStore.current = wikiStore.byKey[key];
		},
		reset: () => {},
	};
	const fakeDetector: ExtensionDetector = {
		has: vi.fn(async () => false),
		invalidate: vi.fn(),
	};
	const reconcile = () =>
		reconcileTools(tools, {
			wikiRegistry: wikiRegistryMock,
			wikiSelection: wikiSelectionMock,
			transport: 'stdio',
			extensions: fakeDetector,
		});
	const ctx = fakeContext({
		wikis: wikiRegistryMock,
		selection: wikiSelectionMock,
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

	it('omits add-wiki and remove-wiki but keeps set-wiki when management is disallowed and 2+ wikis are configured', async () => {
		isManagementAllowedRef.current = false;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		expect(names).not.toContain('add-wiki');
		expect(names).not.toContain('remove-wiki');
		expect(names).toContain('get-page');
		expect(names).toContain('set-wiki');
	});

	it('hides set-wiki, add-wiki, and remove-wiki on the hosted single-wiki shape (1 wiki + management disallowed)', async () => {
		isManagementAllowedRef.current = false;
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { a: wikiA };
		try {
			const { client } = await connectClientAndServer();

			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name);

			expect(names).not.toContain('add-wiki');
			expect(names).not.toContain('remove-wiki');
			expect(names).not.toContain('set-wiki');
			expect(names).toContain('get-page');
		} finally {
			wikiStore.byKey = originalByKey;
		}
	});

	it('rejects calls to add-wiki with a disabled error when wiki management is disallowed', async () => {
		isManagementAllowedRef.current = false;
		const { client } = await connectClientAndServer();

		const result = await client.callTool({
			name: 'add-wiki',
			arguments: { wikiUrl: 'https://en.wikipedia.org' },
		});

		expect(result.isError).toBe(true);
		const content = result.content as Array<{ type: string; text: string }>;
		expect(content[0].text).toMatch(/Tool add-wiki disabled/);
	});

	it('shows set-wiki and remove-wiki when 2 wikis are configured and management is allowed', async () => {
		isManagementAllowedRef.current = true;
		const { client } = await connectClientAndServer();

		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain('set-wiki');
		expect(names).toContain('remove-wiki');
		expect(names).toContain('add-wiki');
	});

	it('hides set-wiki and remove-wiki when only 1 wiki is configured and management is allowed', async () => {
		isManagementAllowedRef.current = true;
		const originalByKey = wikiStore.byKey;
		wikiStore.byKey = { a: wikiA };
		try {
			const { client } = await connectClientAndServer();

			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).not.toContain('set-wiki');
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

	it('omits write tools when the default wiki is readOnly', async () => {
		wikiStore.current = wikiB;
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		for (const w of WRITE_TOOLS) {
			expect(names).not.toContain(w);
		}
		expect(names).toContain('get-page');
		expect(names).toContain('set-wiki');
	});

	it('hides write tools after set-wiki switches to a readOnly wiki', async () => {
		wikiStore.current = wikiA;
		const { client } = await connectClientAndServer();

		await client.callTool({
			name: 'set-wiki',
			arguments: { uri: 'mcp://wikis/b' },
		});

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		for (const w of WRITE_TOOLS) {
			expect(names).not.toContain(w);
		}
	});

	it('restores write tools after set-wiki switches back to a writeable wiki', async () => {
		wikiStore.current = wikiB;
		const { client } = await connectClientAndServer();

		await client.callTool({
			name: 'set-wiki',
			arguments: { uri: 'mcp://wikis/a' },
		});

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		for (const w of WRITE_TOOLS) {
			expect(names).toContain(w);
		}
	});

	it('rejects a write tool call with a disabled error when the active wiki is readOnly', async () => {
		wikiStore.current = wikiB;
		const { client } = await connectClientAndServer();

		const result = await client.callTool({
			name: 'create-page',
			arguments: { title: 'Test', source: 'test' },
		});

		expect(result.isError).toBe(true);
		const content = result.content as Array<{ type: string; text: string }>;
		expect(content[0].text).toMatch(/Tool create-page disabled/);
	});
});
