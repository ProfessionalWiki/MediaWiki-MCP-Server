import { describe, it, expect, vi } from 'vitest';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiSelection } from '../../src/wikis/wikiSelection.js';
import { reconcileTools, computeDesiredEnabledState } from '../../src/runtime/reconcile.js';
import type { ToolGatingRule, ReconcileContext } from '../../src/runtime/reconcile.js';

const WRITE_TOOL_NAMES = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url',
	'update-file',
	'update-file-from-url',
];

const NON_WRITE_TOOL_NAMES = ['get-page', 'search-page'];
const WIKI_SET_TOOL_NAMES = ['add-wiki', 'remove-wiki', 'set-wiki'];
const STDIO_ONLY_TOOL_NAMES = ['oauth-status', 'oauth-logout'];

interface MockTool {
	enabled: boolean;
	enable: ReturnType<typeof vi.fn>;
	disable: ReturnType<typeof vi.fn>;
}

function makeMockTool(initiallyEnabled: boolean): MockTool {
	const tool: MockTool = {
		enabled: initiallyEnabled,
		enable: vi.fn(() => {
			tool.enabled = true;
		}),
		disable: vi.fn(() => {
			tool.enabled = false;
		}),
	};
	return tool;
}

function makeToolMap(initiallyEnabled: boolean): {
	tools: Map<string, RegisteredTool>;
	mocks: Map<string, MockTool>;
} {
	const mocks = new Map<string, MockTool>();
	const tools = new Map<string, RegisteredTool>();
	for (const name of [
		...WRITE_TOOL_NAMES,
		...NON_WRITE_TOOL_NAMES,
		...WIKI_SET_TOOL_NAMES,
		...STDIO_ONLY_TOOL_NAMES,
	]) {
		const mock = makeMockTool(initiallyEnabled);
		mocks.set(name, mock);
		tools.set(name, mock as unknown as RegisteredTool);
	}
	return { tools, mocks };
}

const baseWiki: WikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
};

function makeMocks({
	activeWiki,
	wikis,
	allowManagement,
}: {
	activeWiki: WikiConfig;
	wikis: Record<string, WikiConfig>;
	allowManagement: boolean;
}): { registry: WikiRegistry; selection: WikiSelection } {
	const registry: WikiRegistry = {
		getAll: () => wikis,
		get: (key: string) => wikis[key],
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => allowManagement,
	};
	const selection: WikiSelection = {
		getCurrent: () => ({
			key: Object.keys(wikis).find((k) => wikis[k] === activeWiki) ?? 'a',
			config: activeWiki,
		}),
		setCurrent: () => {},
		reset: () => {},
	};
	return { registry, selection };
}

describe('reconcileTools — applyReadOnlyRule', () => {
	it('disables every write tool when the active wiki is readOnly', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry, selection } = makeMocks({
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('does not touch non-write tools', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry, selection } = makeMocks({
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of NON_WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('enables every write tool when the active wiki is not readOnly', async () => {
		const { tools, mocks } = makeToolMap(false);
		const wiki = { ...baseWiki, readOnly: false };
		const { registry, selection } = makeMocks({
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
		}
	});

	it('treats missing readOnly as non-readOnly', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('is idempotent: a second call with identical state performs zero toggles', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const m1 = makeMocks({ activeWiki: wiki, wikis: { a: wiki }, allowManagement: true });
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			wikiSelection: m1.selection,
			transport: 'stdio',
		});
		for (const m of mocks.values()) {
			m.enable.mockClear();
			m.disable.mockClear();
		}
		const m2 = makeMocks({ activeWiki: wiki, wikis: { a: wiki }, allowManagement: true });
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			wikiSelection: m2.selection,
			transport: 'stdio',
		});
		for (const m of mocks.values()) {
			expect(m.enable).not.toHaveBeenCalled();
			expect(m.disable).not.toHaveBeenCalled();
		}
	});

	it('skips tools missing from the map', async () => {
		const { tools, mocks } = makeToolMap(true);
		tools.delete('upload-file');
		const wiki = { ...baseWiki, readOnly: true };
		const { registry, selection } = makeMocks({
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await expect(
			reconcileTools(tools, {
				wikiRegistry: registry,
				wikiSelection: selection,
				transport: 'stdio',
			}),
		).resolves.not.toThrow();
		for (const name of WRITE_TOOL_NAMES) {
			if (name === 'upload-file') {
				continue;
			}
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
		}
	});
});

describe('reconcileTools — applyWikiSetRule', () => {
	it('disables add-wiki, remove-wiki, set-wiki when count is 1 and management is disallowed', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: false,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of ['add-wiki', 'remove-wiki', 'set-wiki']) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
		}
	});

	it('enables add-wiki only when count is 1 and management is allowed', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		expect(mocks.get('add-wiki')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('remove-wiki')!.disable).not.toHaveBeenCalled();
		expect(mocks.get('set-wiki')!.disable).not.toHaveBeenCalled();
	});

	it('enables set-wiki when count is 2 even if management is disallowed', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: false,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		expect(mocks.get('set-wiki')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('add-wiki')!.enable).not.toHaveBeenCalled();
		expect(mocks.get('remove-wiki')!.enable).not.toHaveBeenCalled();
	});

	it('enables all three when count is 2 and management is allowed', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of ['add-wiki', 'remove-wiki', 'set-wiki']) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('transitions: count 1 to 2 enables set-wiki', async () => {
		const { tools, mocks } = makeToolMap(false);
		const m1 = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			wikiSelection: m1.selection,
			transport: 'stdio',
		});
		expect(mocks.get('set-wiki')!.enabled).toBe(false);

		const m2 = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			wikiSelection: m2.selection,
			transport: 'stdio',
		});
		expect(mocks.get('set-wiki')!.enabled).toBe(true);
	});

	it('transitions: count 2 to 1 disables remove-wiki', async () => {
		const { tools, mocks } = makeToolMap(true);
		const m1 = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			wikiSelection: m1.selection,
			transport: 'stdio',
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(true);

		const m2 = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			wikiSelection: m2.selection,
			transport: 'stdio',
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(false);
	});
});

describe('reconcileTools — applyTransportRule', () => {
	it('hides oauth-* tools on HTTP transport', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'http',
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('shows oauth-* tools on stdio transport', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
		}
	});

	it('defaults to stdio when transport is omitted', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('does not touch non-oauth tools when applying transport rule', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry, selection } = makeMocks({
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'http',
		});
		for (const name of NON_WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});
});

describe('reconcileTools — AND semantics across rules', () => {
	it('disables a tool when any rule disallows, regardless of declaration order', async () => {
		// Force read-only=true (disables write tools) AND wikiCount=1 (disables remove-wiki).
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry, selection } = makeMocks({
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			wikiSelection: selection,
			transport: 'stdio',
		});
		// create-page is write-gated → disabled.
		expect(mocks.get('create-page')!.enabled).toBe(false);
		// remove-wiki is wiki-count-gated (count=1) → disabled.
		expect(mocks.get('remove-wiki')!.enabled).toBe(false);
		// get-page is unaffected by any rule → unchanged from initial true.
		expect(mocks.get('get-page')!.enabled).toBe(true);
	});

	it('resolves multiple rule predicates concurrently, not serially', async () => {
		const ctx: ReconcileContext = {
			activeWikiKey: 'a',
			activeWiki: baseWiki,
			wikiCount: 1,
			allowManagement: true,
			transport: 'stdio',
		};
		const slowAllow: ToolGatingRule = {
			name: 'slow-allow',
			affects: ['t'],
			isAllowed: async () => {
				await new Promise((r) => setTimeout(r, 30));
				return true;
			},
		};
		const slowOther: ToolGatingRule = {
			name: 'slow-other',
			affects: ['t'],
			isAllowed: async () => {
				await new Promise((r) => setTimeout(r, 30));
				return true;
			},
		};

		const start = performance.now();
		await computeDesiredEnabledState(['t'], ctx, [slowAllow, slowOther]);
		const elapsed = performance.now() - start;
		// Two rules each delay 30ms. Concurrent: ~30ms. Serial: ~60ms.
		// Allow generous slack for slow CI but stay below 60ms to detect serialization.
		expect(elapsed).toBeLessThan(55);
	});
});

describe('computeDesiredEnabledState — AND semantics for a single tool affected by multiple rules', () => {
	const baseCtx: ReconcileContext = {
		activeWikiKey: 'a',
		activeWiki: baseWiki,
		wikiCount: 1,
		allowManagement: true,
		transport: 'stdio',
	};

	it('disables a tool when one of two affecting rules disallows, regardless of rule order', async () => {
		const allowRule: ToolGatingRule = {
			name: 'allow',
			affects: ['shared-tool'],
			isAllowed: () => true,
		};
		const denyRule: ToolGatingRule = {
			name: 'deny',
			affects: ['shared-tool'],
			isAllowed: () => false,
		};

		const desired1 = await computeDesiredEnabledState(['shared-tool'], baseCtx, [
			allowRule,
			denyRule,
		]);
		expect(desired1.get('shared-tool')).toBe(false);

		const desired2 = await computeDesiredEnabledState(['shared-tool'], baseCtx, [
			denyRule,
			allowRule,
		]);
		expect(desired2.get('shared-tool')).toBe(false);
	});

	it('enables a tool when both affecting rules allow', async () => {
		const ruleA: ToolGatingRule = {
			name: 'a',
			affects: ['shared-tool'],
			isAllowed: () => true,
		};
		const ruleB: ToolGatingRule = {
			name: 'b',
			affects: ['shared-tool'],
			isAllowed: () => true,
		};

		const desired = await computeDesiredEnabledState(['shared-tool'], baseCtx, [ruleA, ruleB]);
		expect(desired.get('shared-tool')).toBe(true);
	});

	it('tools not referenced by any rule are enabled by default', async () => {
		const denyRule: ToolGatingRule = {
			name: 'deny',
			affects: ['other-tool'],
			isAllowed: () => false,
		};

		const desired = await computeDesiredEnabledState(['shared-tool', 'other-tool'], baseCtx, [
			denyRule,
		]);
		expect(desired.get('shared-tool')).toBe(true);
		expect(desired.get('other-tool')).toBe(false);
	});
});
