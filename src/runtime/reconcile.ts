import type { RegisteredTool } from '@modelcontextprotocol/server';
import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { WikiProbe } from '../wikis/wikiProbe.ts';
import type { ExtensionPack } from '../tools/extensions/types.ts';
import { WRITE_TOOL_NAMES } from './wikiCapability.ts';
import { packToolRefusal } from '../tools/extensions/index.ts';

export type Reconcile = () => Promise<void>;

export interface ReconcileDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly transport: 'http' | 'stdio';
	readonly wikiProbe: WikiProbe;
	readonly extensionPacks: readonly ExtensionPack[];
	readonly descriptors: readonly DeclaredTool[];
}

/** The slice of a tool descriptor reconcile reads. */
export interface DeclaredTool {
	readonly name: string;
	readonly offeredWhen?: (context: ReconcileContext) => boolean;
}

export interface ReconcileContext {
	readonly allWikis: Readonly<Record<string, WikiConfig>>;
	readonly wikiCount: number;
	readonly allowManagement: boolean;
	readonly transport: 'http' | 'stdio';
	readonly wikiProbe: WikiProbe;
}

export interface ToolGatingRule {
	readonly name: string;
	readonly affects: readonly string[];
	readonly isAllowed: (ctx: ReconcileContext) => boolean | Promise<boolean>;
}

const STATIC_RULES: readonly ToolGatingRule[] = [
	{
		name: 'read-only',
		affects: WRITE_TOOL_NAMES,
		// Union gating: write tools stay offered if ANY configured wiki is
		// writable. The per-call capability guard rejects a write to a
		// read-only wiki.
		isAllowed: (c) => Object.values(c.allWikis).some((w) => w.readOnly !== true),
	},
];

function declaredRules(descriptors: readonly DeclaredTool[]): readonly ToolGatingRule[] {
	return descriptors.flatMap((tool) =>
		tool.offeredWhen === undefined
			? []
			: [{ name: tool.name, affects: [tool.name], isAllowed: tool.offeredWhen }],
	);
}

// Union gating: a pack tool is offered while some ONE configured wiki can run
// it, judged per wiki so a gated tool is not offered because one wiki has the
// extension and another satisfies the gate. The per-call capability guard
// refuses a call to a wiki that cannot run it.
function buildExtensionRules(packs: readonly ExtensionPack[]): readonly ToolGatingRule[] {
	return packs.flatMap((pack) =>
		pack.tools.map((tool) => ({
			name: `${pack.id}:${tool.name}`,
			affects: [tool.name],
			isAllowed: async (c: ReconcileContext) => {
				const keys = Object.keys(c.allWikis);
				const identities = await Promise.all(keys.map((key) => c.wikiProbe.inspect(key)));
				return identities.some(
					(identity, i) => packToolRefusal(pack, tool.name, identity, keys[i]) === undefined,
				);
			},
		})),
	);
}

function buildContext(deps: ReconcileDeps): ReconcileContext {
	const allWikis = deps.wikiRegistry.getAll();
	return {
		allWikis,
		wikiCount: Object.keys(allWikis).length,
		allowManagement: deps.wikiRegistry.isManagementAllowed(),
		transport: deps.transport,
		wikiProbe: deps.wikiProbe,
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
	const rules = [
		...STATIC_RULES,
		...declaredRules(deps.descriptors),
		...buildExtensionRules(deps.extensionPacks),
	];
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
