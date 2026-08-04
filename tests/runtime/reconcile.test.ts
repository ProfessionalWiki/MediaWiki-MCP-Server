import { describe, it, expect, vi, type Mock } from 'vitest';
import type { RegisteredTool } from '@modelcontextprotocol/server';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';
import type { ActiveWiki } from '../../src/wikis/activeWiki.ts';
import type { WikiProbe } from '../../src/wikis/wikiProbe.ts';
import { reconcileTools, computeDesiredEnabledState } from '../../src/runtime/reconcile.ts';
import type { ToolGatingRule, ReconcileContext } from '../../src/runtime/reconcile.ts';
import { WRITE_TOOL_NAMES } from '../../src/runtime/wikiCapability.ts';
import type { ExtensionPack, WikiGate } from '../../src/tools/extensions/types.ts';
import type { Tool } from '../../src/runtime/tool.ts';

const NON_WRITE_TOOL_NAMES = ['get-page', 'search-page'];
const WIKI_SET_TOOL_NAMES = ['add-wiki', 'remove-wiki', 'list-wikis'];
const STDIO_ONLY_TOOL_NAMES = ['oauth-status', 'oauth-logout'];

interface MockTool {
	enabled: boolean;
	enable: Mock;
	disable: Mock;
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

function makeToolMapOf(
	names: readonly string[],
	initiallyEnabled: boolean,
): { tools: Map<string, RegisteredTool>; mocks: Map<string, MockTool> } {
	const mocks = new Map<string, MockTool>();
	const tools = new Map<string, RegisteredTool>();
	for (const name of names) {
		const mock = makeMockTool(initiallyEnabled);
		mocks.set(name, mock);
		tools.set(name, mock as unknown as RegisteredTool);
	}
	return { tools, mocks };
}

function makeToolMapWithExtensions(initiallyEnabled: boolean): {
	tools: Map<string, RegisteredTool>;
	mocks: Map<string, MockTool>;
} {
	const { tools, mocks } = makeToolMap(initiallyEnabled);
	for (const pack of ALL_PACKS) {
		for (const t of pack.tools) {
			const mock = makeMockTool(initiallyEnabled);
			mocks.set(t.name, mock);
			tools.set(t.name, mock as unknown as RegisteredTool);
		}
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
	activeWikiConfig,
	wikis,
	allowManagement,
}: {
	activeWikiConfig: WikiConfig;
	wikis: Record<string, WikiConfig>;
	allowManagement: boolean;
}): { registry: WikiRegistry; activeWiki: ActiveWiki } {
	const registry: WikiRegistry = {
		getAll: () => wikis,
		get: (key: string) => wikis[key],
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => allowManagement,
	};
	const activeWiki: ActiveWiki = {
		get: () => ({
			key: Object.keys(wikis).find((k) => wikis[k] === activeWikiConfig) ?? 'a',
			config: activeWikiConfig,
		}),
		getDefaultKey: () => Object.keys(wikis).find((k) => wikis[k] === activeWikiConfig) ?? 'a',
	};
	return { registry, activeWiki };
}

function makeFakeProbe(answers: Record<string, boolean> = {}): WikiProbe {
	return {
		hasExtension: vi.fn(
			async (wikiKey: string, name: string) => answers[`${wikiKey}:${name}`] ?? false,
		),
		hasAnyExtension: vi.fn(async (wikiKey: string, names: readonly string[]) =>
			names.some((name) => answers[`${wikiKey}:${name}`] ?? false),
		),
		inspect: vi.fn(async () => ({ reachable: true, extensions: new Set<string>() })),
		invalidate: vi.fn(),
	};
}

function makeFakePack(
	id: string,
	extensionNames: readonly string[],
	toolNames: readonly string[],
	wikiGate?: WikiGate,
): ExtensionPack {
	return {
		id,
		extensionNames,
		// Synthetic tools — only `name` matters for reconcile (gating works on names).
		// oxlint-disable-next-line typescript/no-explicit-any
		tools: toolNames.map((name) => ({ name }) as unknown as Tool<any>),
		...(wikiGate !== undefined ? { wikiGate } : {}),
	};
}

const SMW_PACK = makeFakePack('smw', ['SemanticMediaWiki'], ['smw-query', 'smw-list-properties']);
const BUCKET_PACK = makeFakePack('bucket', ['Bucket'], ['bucket-query']);
const CARGO_PACK = makeFakePack(
	'cargo',
	['Cargo', 'LIBRARIAN'],
	['cargo-list-tables', 'cargo-describe-table', 'cargo-query'],
);
const ALL_PACKS: readonly ExtensionPack[] = [SMW_PACK, BUCKET_PACK, CARGO_PACK];

describe('reconcileTools — applyReadOnlyRule', () => {
	it('disables every write tool when the active wiki is readOnly', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('does not touch non-write tools', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of NON_WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('enables every write tool when the active wiki is not readOnly', async () => {
		const { tools, mocks } = makeToolMap(false);
		const wiki = { ...baseWiki, readOnly: false };
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
		}
	});

	it('treats missing readOnly as non-readOnly', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('is idempotent: a second call with identical state performs zero toggles', async () => {
		const { tools, mocks } = makeToolMap(true);
		const wiki = { ...baseWiki, readOnly: true };
		const m1 = makeMocks({ activeWikiConfig: wiki, wikis: { a: wiki }, allowManagement: true });
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const m of mocks.values()) {
			m.enable.mockClear();
			m.disable.mockClear();
		}
		const m2 = makeMocks({ activeWikiConfig: wiki, wikis: { a: wiki }, allowManagement: true });
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
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
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await expect(
			reconcileTools(tools, {
				wikiRegistry: registry,
				transport: 'stdio',
				wikiProbe: makeFakeProbe(),
				extensionPacks: ALL_PACKS,
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

describe('reconcileTools — read-only gating of extension write tools', () => {
	const NEOWIKI_WRITE_TOOL = 'neowiki-create-subject';
	const NEOWIKI_READ_TOOL = 'neowiki-cypher-query';
	const NEOWIKI_PACK = makeFakePack(
		'neowiki',
		['NeoWiki'],
		[NEOWIKI_WRITE_TOOL, NEOWIKI_READ_TOOL],
	);

	it('hides an extension write tool from tools/list on a read-only wiki while keeping the read tool', async () => {
		const { tools, mocks } = makeToolMapOf([NEOWIKI_WRITE_TOOL, NEOWIKI_READ_TOOL], true);
		const wiki = { ...baseWiki, readOnly: true };
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:NeoWiki': true }),
			extensionPacks: [NEOWIKI_PACK],
		});
		// The read-only rule keys off the production WRITE_TOOL_NAMES, which now
		// includes extension writes — so the write tool is gated even though the
		// extension is present, while the read tool stays offered.
		expect(mocks.get(NEOWIKI_WRITE_TOOL)!.enabled).toBe(false);
		expect(mocks.get(NEOWIKI_WRITE_TOOL)!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get(NEOWIKI_READ_TOOL)!.enabled).toBe(true);
		expect(mocks.get(NEOWIKI_READ_TOOL)!.disable).not.toHaveBeenCalled();
	});

	it('offers extension write tools on a writable wiki with the extension present', async () => {
		const { tools, mocks } = makeToolMapOf([NEOWIKI_WRITE_TOOL, NEOWIKI_READ_TOOL], false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:NeoWiki': true }),
			extensionPacks: [NEOWIKI_PACK],
		});
		expect(mocks.get(NEOWIKI_WRITE_TOOL)!.enabled).toBe(true);
		expect(mocks.get(NEOWIKI_READ_TOOL)!.enabled).toBe(true);
	});
});

describe('reconcileTools — applyWikiSetRule', () => {
	it('disables add-wiki and remove-wiki when count is 1 and management is disallowed', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: false,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of ['add-wiki', 'remove-wiki']) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
		}
	});

	it('enables add-wiki only when count is 1 and management is allowed', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('add-wiki')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('remove-wiki')!.disable).not.toHaveBeenCalled();
	});

	it('enables add-wiki and remove-wiki when count is 2 and management is allowed', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of ['add-wiki', 'remove-wiki']) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('transitions: count 1 to 2 enables remove-wiki', async () => {
		const { tools, mocks } = makeToolMap(false);
		const m1 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(false);

		const m2 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(true);
	});

	it('transitions: count 2 to 1 disables remove-wiki', async () => {
		const { tools, mocks } = makeToolMap(true);
		const m1 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(true);

		const m2 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('remove-wiki')!.enabled).toBe(false);
	});
});

describe('reconcileTools — applyListWikisRule', () => {
	it('disables list-wikis when only one wiki is configured', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: false,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('list-wikis')!.enable).not.toHaveBeenCalled();
	});

	it('keeps list-wikis disabled with one wiki even when management is allowed', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.disable).toHaveBeenCalledTimes(1);
	});

	it('enables list-wikis when two or more wikis are configured, regardless of management', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: false,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('list-wikis')!.disable).not.toHaveBeenCalled();
	});

	it('transitions: count 1 to 2 enables list-wikis', async () => {
		const { tools, mocks } = makeToolMap(false);
		const m1 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.enabled).toBe(false);

		const m2 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.enabled).toBe(true);
	});

	it('transitions: count 2 to 1 disables list-wikis', async () => {
		const { tools, mocks } = makeToolMap(true);
		const m1 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m1.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.enabled).toBe(true);

		const m2 = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: m2.registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('list-wikis')!.enabled).toBe(false);
	});
});

describe('reconcileTools — applyTransportRule', () => {
	it('hides oauth-* tools on HTTP transport', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'http',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.enable).not.toHaveBeenCalled();
		}
	});

	it('shows oauth-* tools on stdio transport', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
		}
	});

	it('defaults to stdio when transport is omitted', async () => {
		const { tools, mocks } = makeToolMap(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of STDIO_ONLY_TOOL_NAMES) {
			expect(mocks.get(name)!.enable).toHaveBeenCalledTimes(1);
		}
	});

	it('does not touch non-oauth tools when applying transport rule', async () => {
		const { tools, mocks } = makeToolMap(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'http',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
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
		const { registry } = makeMocks({
			activeWikiConfig: wiki,
			wikis: { a: wiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
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
			allWikis: { a: baseWiki },
			wikiCount: 1,
			allowManagement: true,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
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
		allWikis: { a: baseWiki },
		wikiCount: 1,
		allowManagement: true,
		transport: 'stdio',
		wikiProbe: makeFakeProbe(),
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

describe('reconcileTools — applySmwExtensionRule', () => {
	function makeToolMapWithSmw(initiallyEnabled: boolean): {
		tools: Map<string, RegisteredTool>;
		mocks: Map<string, MockTool>;
	} {
		const mocks = new Map<string, MockTool>();
		const tools = new Map<string, RegisteredTool>();
		for (const name of ['smw-query', 'smw-list-properties', 'get-page']) {
			const mock = makeMockTool(initiallyEnabled);
			mocks.set(name, mock);
			tools.set(name, mock as unknown as RegisteredTool);
		}
		return { tools, mocks };
	}

	it('disables both SMW tools when the detector resolves false', async () => {
		const { tools, mocks } = makeToolMapWithSmw(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({}),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('smw-query')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('smw-list-properties')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('get-page')!.disable).not.toHaveBeenCalled();
	});

	it('enables both SMW tools when the detector resolves true', async () => {
		const { tools, mocks } = makeToolMapWithSmw(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:SemanticMediaWiki': true }),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('smw-query')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('smw-list-properties')!.enable).toHaveBeenCalledTimes(1);
	});

	it('queries the detector with the active wiki key', async () => {
		const { tools } = makeToolMapWithSmw(false);
		const hasAnySpy = vi.fn(async () => true);
		const probe: WikiProbe = {
			hasExtension: vi.fn(async () => false),
			hasAnyExtension: hasAnySpy,
			inspect: vi.fn(async () => ({ reachable: true, extensions: new Set<string>() })),
			invalidate: vi.fn(),
		};
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: probe,
			extensionPacks: ALL_PACKS,
		});
		expect(hasAnySpy).toHaveBeenCalledWith('a', ['SemanticMediaWiki']);
	});
});

describe('reconcileTools — applyBucketExtensionRule', () => {
	function makeToolMapWithBucket(initiallyEnabled: boolean): {
		tools: Map<string, RegisteredTool>;
		mocks: Map<string, MockTool>;
	} {
		const mocks = new Map<string, MockTool>();
		const tools = new Map<string, RegisteredTool>();
		for (const name of ['bucket-query', 'get-page']) {
			const mock = makeMockTool(initiallyEnabled);
			mocks.set(name, mock);
			tools.set(name, mock as unknown as RegisteredTool);
		}
		return { tools, mocks };
	}

	it('disables bucket-query when the detector resolves false', async () => {
		const { tools, mocks } = makeToolMapWithBucket(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({}),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('bucket-query')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('get-page')!.disable).not.toHaveBeenCalled();
	});

	it('enables bucket-query when the detector resolves true', async () => {
		const { tools, mocks } = makeToolMapWithBucket(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:Bucket': true }),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('bucket-query')!.enable).toHaveBeenCalledTimes(1);
	});

	it('queries the detector with the active wiki key and ["Bucket"]', async () => {
		const { tools } = makeToolMapWithBucket(false);
		const hasAnySpy = vi.fn(async () => true);
		const probe: WikiProbe = {
			hasExtension: vi.fn(async () => false),
			hasAnyExtension: hasAnySpy,
			inspect: vi.fn(async () => ({ reachable: true, extensions: new Set<string>() })),
			invalidate: vi.fn(),
		};
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: probe,
			extensionPacks: ALL_PACKS,
		});
		expect(hasAnySpy).toHaveBeenCalledWith('a', ['Bucket']);
	});
});

describe('reconcileTools — applyCargoExtensionRule', () => {
	function makeToolMapWithCargo(initiallyEnabled: boolean): {
		tools: Map<string, RegisteredTool>;
		mocks: Map<string, MockTool>;
	} {
		const mocks = new Map<string, MockTool>();
		const tools = new Map<string, RegisteredTool>();
		for (const name of ['cargo-list-tables', 'cargo-describe-table', 'cargo-query', 'get-page']) {
			const mock = makeMockTool(initiallyEnabled);
			mocks.set(name, mock);
			tools.set(name, mock as unknown as RegisteredTool);
		}
		return { tools, mocks };
	}

	it('disables all Cargo tools when the detector resolves false', async () => {
		const { tools, mocks } = makeToolMapWithCargo(true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({}),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('cargo-list-tables')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-describe-table')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-query')!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get('get-page')!.disable).not.toHaveBeenCalled();
	});

	it('enables all Cargo tools when the detector resolves true', async () => {
		const { tools, mocks } = makeToolMapWithCargo(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:Cargo': true }),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('cargo-list-tables')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-describe-table')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-query')!.enable).toHaveBeenCalledTimes(1);
	});

	it('queries the detector with the active wiki key and the canonical+wiki.gg names', async () => {
		const { tools } = makeToolMapWithCargo(false);
		const hasAnySpy = vi.fn(async () => true);
		const probe: WikiProbe = {
			hasExtension: vi.fn(async () => false),
			hasAnyExtension: hasAnySpy,
			inspect: vi.fn(async () => ({ reachable: true, extensions: new Set<string>() })),
			invalidate: vi.fn(),
		};
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: probe,
			extensionPacks: ALL_PACKS,
		});
		expect(hasAnySpy).toHaveBeenCalledWith('a', ['Cargo', 'LIBRARIAN']);
	});

	it('enables all Cargo tools on a wiki.gg-rebranded LIBRARIAN install', async () => {
		const { tools, mocks } = makeToolMapWithCargo(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:LIBRARIAN': true }),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('cargo-list-tables')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-describe-table')!.enable).toHaveBeenCalledTimes(1);
		expect(mocks.get('cargo-query')!.enable).toHaveBeenCalledTimes(1);
	});
});

describe('reconcileTools — union gating', () => {
	it('enables a pack when only a non-default wiki has the extension', async () => {
		const { tools, mocks } = makeToolMapWithExtensions(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { def: baseWiki, other: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'other:Cargo': true }),
			extensionPacks: ALL_PACKS,
		});
		for (const name of ['cargo-query', 'cargo-list-tables', 'cargo-describe-table']) {
			expect(mocks.get(name)!.enable).toHaveBeenCalled();
		}
	});

	it('keeps a pack disabled when no wiki has the extension', async () => {
		const { tools, mocks } = makeToolMapWithExtensions(false);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { def: baseWiki, other: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({}),
			extensionPacks: ALL_PACKS,
		});
		expect(mocks.get('cargo-query')!.enable).not.toHaveBeenCalled();
	});

	it('keeps write tools enabled when only a non-default wiki is writable', async () => {
		const { tools, mocks } = makeToolMap(true);
		const roWiki = { ...baseWiki, readOnly: true };
		const { registry } = makeMocks({
			activeWikiConfig: roWiki,
			wikis: { def: roWiki, other: baseWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).not.toHaveBeenCalled();
		}
	});

	it('disables write tools only when every wiki is read-only', async () => {
		const { tools, mocks } = makeToolMap(true);
		const roWiki = { ...baseWiki, readOnly: true };
		const { registry } = makeMocks({
			activeWikiConfig: roWiki,
			wikis: { def: roWiki, other: roWiki },
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(),
			extensionPacks: ALL_PACKS,
		});
		for (const name of WRITE_TOOL_NAMES) {
			expect(mocks.get(name)!.disable).toHaveBeenCalledTimes(1);
		}
	});
});

describe('reconcileTools — wikiGateRule', () => {
	const GATED_TOOL = 'gated-pack-query';
	const UNGATED_TOOL = 'gated-pack-read';
	const GATED_PACK = makeFakePack('gated', ['GatedExtension'], [UNGATED_TOOL, GATED_TOOL], {
		tools: [GATED_TOOL],
		isSatisfied: (wiki) => (wiki.sparqlEndpoint ?? '').trim() !== '',
		refusal: (wikiKey) => `Wiki "${wikiKey}" has no query service.`,
	});
	const SATISFIED: WikiConfig = { ...baseWiki, sparqlEndpoint: 'https://query.example/sparql' };

	async function reconcileWith(
		tools: Map<string, RegisteredTool>,
		wikis: Record<string, WikiConfig>,
	): Promise<void> {
		const { registry } = makeMocks({
			activeWikiConfig: Object.values(wikis)[0],
			wikis,
			allowManagement: true,
		});
		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe(
				Object.fromEntries(Object.keys(wikis).map((key) => [`${key}:GatedExtension`, true])),
			),
			extensionPacks: [GATED_PACK],
		});
	}

	it('hides the gated tool when no wiki satisfies the gate', async () => {
		const { tools, mocks } = makeToolMapOf([UNGATED_TOOL, GATED_TOOL], true);

		await reconcileWith(tools, { a: baseWiki });

		expect(mocks.get(GATED_TOOL)!.disable).toHaveBeenCalledTimes(1);
		expect(mocks.get(UNGATED_TOOL)!.disable).not.toHaveBeenCalled();
	});

	it('offers the gated tool once a wiki satisfies the gate', async () => {
		const { tools, mocks } = makeToolMapOf([UNGATED_TOOL, GATED_TOOL], false);

		await reconcileWith(tools, { a: SATISFIED });

		expect(mocks.get(GATED_TOOL)!.enable).toHaveBeenCalledTimes(1);
	});

	it('treats a blank configured value as not satisfying the gate', async () => {
		const { tools, mocks } = makeToolMapOf([UNGATED_TOOL, GATED_TOOL], true);

		await reconcileWith(tools, { a: { ...baseWiki, sparqlEndpoint: '   ' } });

		expect(mocks.get(GATED_TOOL)!.disable).toHaveBeenCalledTimes(1);
	});

	// Union gating, as for the extension gate itself: the per-call guard is what
	// refuses the wiki that does not satisfy it.
	it('keeps the gated tool offered when only a non-default wiki satisfies the gate', async () => {
		const { tools, mocks } = makeToolMapOf([UNGATED_TOOL, GATED_TOOL], false);

		await reconcileWith(tools, { def: baseWiki, other: SATISFIED });

		expect(mocks.get(GATED_TOOL)!.enable).toHaveBeenCalledTimes(1);
	});

	it('hides the gated tool only when no wiki of several satisfies the gate', async () => {
		const { tools, mocks } = makeToolMapOf([UNGATED_TOOL, GATED_TOOL], true);

		await reconcileWith(tools, { def: baseWiki, other: baseWiki });

		expect(mocks.get(GATED_TOOL)!.disable).toHaveBeenCalledTimes(1);
	});

	it('leaves a pack with no gate alone', async () => {
		const { tools, mocks } = makeToolMapOf(['smw-query'], true);
		const { registry } = makeMocks({
			activeWikiConfig: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true,
		});

		await reconcileTools(tools, {
			wikiRegistry: registry,
			transport: 'stdio',
			wikiProbe: makeFakeProbe({ 'a:SemanticMediaWiki': true }),
			extensionPacks: [SMW_PACK],
		});

		expect(mocks.get('smw-query')!.disable).not.toHaveBeenCalled();
	});
});
