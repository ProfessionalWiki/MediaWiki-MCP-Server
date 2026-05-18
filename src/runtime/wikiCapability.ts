import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './context.js';
import type { ExtensionPack } from '../tools/extensions/types.js';
import { extensionPacks } from '../tools/extensions/index.js';

// The wiki-mutating tools. Shared by reconcile's read-only rule and the
// per-call capability guard.
export const WRITE_TOOL_NAMES: readonly string[] = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url',
	'update-file',
	'update-file-from-url',
];

const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

// toolName -> the extension pack that provides it.
const PACK_BY_TOOL: ReadonlyMap<string, ExtensionPack> = ((): ReadonlyMap<
	string,
	ExtensionPack
> => {
	const map = new Map<string, ExtensionPack>();
	for (const pack of extensionPacks) {
		for (const tool of pack.tools) {
			map.set(tool.name, pack);
		}
	}
	return map;
})();

/**
 * Verifies a wiki-scoped tool can run against the resolved wiki. Returns an
 * error CallToolResult to short-circuit dispatch, or undefined when the call
 * may proceed. Non-extension, non-write tools always return undefined.
 */
export async function checkWikiCapability(
	toolName: string,
	wikiKey: string,
	ctx: ToolContext,
): Promise<CallToolResult | undefined> {
	const pack = PACK_BY_TOOL.get(toolName);
	if (pack) {
		const present = await ctx.extensions.hasAny(wikiKey, pack.extensionNames);
		if (!present) {
			return ctx.format.invalidInput(
				`The ${pack.extensionNames[0]} extension is not installed on wiki "${wikiKey}". ` +
					'Use list-wikis to see which wikis support it.',
			);
		}
	}
	if (WRITE_TOOL_SET.has(toolName)) {
		const config = ctx.wikis.get(wikiKey);
		if (config?.readOnly === true) {
			return ctx.format.permissionDenied(`Wiki "${wikiKey}" is configured read-only.`);
		}
	}
	return undefined;
}
