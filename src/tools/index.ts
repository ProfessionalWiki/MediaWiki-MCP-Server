import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { errorMessage } from '../errors/isErrnoException.ts';
import { logger } from '../runtime/logger.ts';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext, ManagementContext } from '../runtime/context.ts';
import type { Reconcile } from '../runtime/reconcile.ts';
import { dispatch } from '../runtime/dispatcher.ts';
import { register } from '../runtime/register.ts';

import { extensionPacks } from './extensions/index.ts';
import { standardTools } from './standardTools.ts';
import { addWiki } from './add-wiki.ts';
import { removeWiki } from './remove-wiki.ts';

// oxlint-disable-next-line typescript/no-explicit-any
const managementTools: Tool<any, ManagementContext>[] = [addWiki, removeWiki];

export function registerAllTools(
	server: McpServer,
	reconcile: Reconcile,
	ctx: ToolContext,
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();

	for (const tool of standardTools) {
		try {
			registered.set(tool.name, register(server, tool, dispatch(tool, ctx)));
		} catch (error) {
			logger.error('Error registering tool', { error: errorMessage(error) });
		}
	}

	const mgmtCtx: ManagementContext = { ...ctx, reconcile };
	for (const tool of managementTools) {
		try {
			registered.set(tool.name, register(server, tool, dispatch(tool, mgmtCtx)));
		} catch (error) {
			logger.error('Error registering tool', { error: errorMessage(error) });
		}
	}

	// Extension-gated tools start disabled. They're enabled by reconcile() once
	// the extension detector confirms the relevant extension is installed on
	// the active wiki. This avoids a race where tools/list arrives before the
	// initial reconcile completes.
	for (const pack of extensionPacks) {
		for (const tool of pack.tools) {
			const reg = registered.get(tool.name);
			if (reg && reg.enabled) {
				reg.disable();
			}
		}
	}

	return registered;
}
