import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import type { WikiSelection } from '../wikis/wikiSelection.js';

export type Reconcile = () => Promise<void>;

export interface ReconcileDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly wikiSelection: WikiSelection;
	readonly transport: 'http' | 'stdio';
}

interface ReconcileContext {
	readonly activeWikiKey: string;
	readonly activeWiki: Readonly<WikiConfig>;
	readonly wikiCount: number;
	readonly allowManagement: boolean;
	readonly transport: 'http' | 'stdio';
}

interface ToolGatingRule {
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

const RULES: readonly ToolGatingRule[] = [
	{
		name: 'read-only',
		affects: WRITE_TOOL_NAMES,
		isAllowed: (c) => !c.activeWiki.readOnly,
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
	{
		name: 'set-wiki',
		affects: ['set-wiki'],
		isAllowed: (c) => c.wikiCount >= 2,
	},
];

function buildContext(deps: ReconcileDeps): ReconcileContext {
	const { key, config } = deps.wikiSelection.getCurrent();
	return {
		activeWikiKey: key,
		activeWiki: config,
		wikiCount: Object.keys(deps.wikiRegistry.getAll()).length,
		allowManagement: deps.wikiRegistry.isManagementAllowed(),
		transport: deps.transport,
	};
}

export async function reconcileTools(
	tools: Map<string, RegisteredTool>,
	deps: ReconcileDeps,
): Promise<void> {
	const ctx = buildContext(deps);
	const results = await Promise.all(
		RULES.map(async (r) => ({ rule: r, allowed: await r.isAllowed(ctx) })),
	);

	// Each tool starts allowed. A rule that disallows it flips to false.
	// Tools not affected by any rule remain at their initial map state (allowed).
	const desired = new Map<string, boolean>();
	for (const name of tools.keys()) {
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
