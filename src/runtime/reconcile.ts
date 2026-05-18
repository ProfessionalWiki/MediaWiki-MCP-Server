import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import type { ExtensionDetector } from '../wikis/extensionDetector.js';
import type { ExtensionPack } from '../tools/extensions/types.js';

export type Reconcile = () => Promise<void>;

export interface ReconcileDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly transport: 'http' | 'stdio';
	readonly extensions: ExtensionDetector;
	readonly extensionPacks: readonly ExtensionPack[];
}

export interface ReconcileContext {
	readonly allWikis: Readonly<Record<string, WikiConfig>>;
	readonly wikiCount: number;
	readonly allowManagement: boolean;
	readonly transport: 'http' | 'stdio';
	readonly extensions: ExtensionDetector;
}

export interface ToolGatingRule {
	readonly name: string;
	readonly affects: readonly string[];
	readonly isAllowed: (ctx: ReconcileContext) => boolean | Promise<boolean>;
}

const WRITE_TOOL_NAMES: readonly string[] = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url',
	'update-file',
	'update-file-from-url',
];

const STDIO_ONLY_TOOLS: readonly string[] = ['oauth-status', 'oauth-logout'];

const STATIC_RULES: readonly ToolGatingRule[] = [
	{
		name: 'read-only',
		affects: WRITE_TOOL_NAMES,
		// Union gating: write tools stay offered if ANY configured wiki is
		// writable. The per-call capability guard rejects a write to a
		// read-only wiki.
		isAllowed: (c) => Object.values(c.allWikis).some((w) => w.readOnly !== true),
	},
	{
		name: 'stdio-only',
		affects: STDIO_ONLY_TOOLS,
		isAllowed: (c) => c.transport === 'stdio',
	},
	{
		name: 'wiki-mgmt',
		affects: ['add-wiki'],
		isAllowed: (c) => c.allowManagement,
	},
	{
		name: 'remove-wiki',
		affects: ['remove-wiki'],
		isAllowed: (c) => c.allowManagement && c.wikiCount >= 2,
	},
];

function buildExtensionRules(packs: readonly ExtensionPack[]): readonly ToolGatingRule[] {
	return packs.map((pack) => ({
		name: `${pack.id}-extension`,
		affects: pack.tools.map((t) => t.name),
		// Union gating: the pack's tools are offered if ANY configured wiki has
		// the extension. The per-call capability guard rejects a call to a wiki
		// that lacks it.
		isAllowed: async (c) => {
			const results = await Promise.all(
				Object.keys(c.allWikis).map((key) => c.extensions.hasAny(key, pack.extensionNames)),
			);
			return results.some((r) => r);
		},
	}));
}

function buildContext(deps: ReconcileDeps): ReconcileContext {
	const allWikis = deps.wikiRegistry.getAll();
	return {
		allWikis,
		wikiCount: Object.keys(allWikis).length,
		allowManagement: deps.wikiRegistry.isManagementAllowed(),
		transport: deps.transport,
		extensions: deps.extensions,
	};
}

export async function computeDesiredEnabledState(
	toolNames: Iterable<string>,
	ctx: ReconcileContext,
	rules: readonly ToolGatingRule[],
): Promise<Map<string, boolean>> {
	const results = await Promise.all(
		rules.map(async (r) => ({ rule: r, allowed: await r.isAllowed(ctx) })),
	);

	// Each tool starts allowed. A rule that disallows it flips to false.
	// Tools not affected by any rule remain enabled.
	const desired = new Map<string, boolean>();
	for (const name of toolNames) {
		desired.set(name, true);
	}
	for (const { rule, allowed } of results) {
		if (allowed) {
			continue;
		}
		for (const toolName of rule.affects) {
			if (desired.has(toolName)) {
				desired.set(toolName, false);
			}
		}
	}
	return desired;
}

export async function reconcileTools(
	tools: Map<string, RegisteredTool>,
	deps: ReconcileDeps,
): Promise<void> {
	const ctx = buildContext(deps);
	const rules = [...STATIC_RULES, ...buildExtensionRules(deps.extensionPacks)];
	const desired = await computeDesiredEnabledState(tools.keys(), ctx, rules);
	for (const [name, shouldEnable] of desired) {
		toggle(tools.get(name), shouldEnable);
	}
}

function toggle(tool: RegisteredTool | undefined, shouldBeEnabled: boolean): void {
	if (!tool) {
		return;
	}
	if (shouldBeEnabled && !tool.enabled) {
		tool.enable();
	} else if (!shouldBeEnabled && tool.enabled) {
		tool.disable();
	}
}
