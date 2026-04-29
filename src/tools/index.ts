import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { logger } from '../runtime/logger.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext, ManagementContext } from '../runtime/context.js';
import type { Reconcile } from '../runtime/reconcile.js';
import { dispatch } from '../runtime/dispatcher.js';
import { register } from '../runtime/register.js';

import { getPage } from './get-page.js';
import { getPages } from './get-pages.js';
import { getPageHistory } from './get-page-history.js';
import { getRecentChanges } from './get-recent-changes.js';
import { searchPage } from './search-page.js';
import { searchPageByPrefix } from './search-page-by-prefix.js';
import { parseWikitext } from './parse-wikitext.js';
import { comparePages } from './compare-pages.js';
import { getFile } from './get-file.js';
import { getRevision } from './get-revision.js';
import { getCategoryMembers } from './get-category-members.js';
import { createPage } from './create-page.js';
import { updatePage } from './update-page.js';
import { deletePage } from './delete-page.js';
import { undeletePage } from './undelete-page.js';
import { uploadFile } from './upload-file.js';
import { uploadFileFromUrl } from './upload-file-from-url.js';
import { updateFile } from './update-file.js';
import { updateFileFromUrl } from './update-file-from-url.js';
import { addWiki } from './add-wiki.js';
import { removeWiki } from './remove-wiki.js';
import { setWiki } from './set-wiki.js';

// `Tool<any>` widens the heterogeneous-schema array; `inputSchema: TSchema`
// is invariant in `TSchema`, so `Tool<never>` and `Tool<ZodRawShape>` both
// fail this assignment. The dispatcher's own generic re-narrows TSchema
// when each tool's handler is wrapped.
// oxlint-disable-next-line typescript/no-explicit-any
export const standardTools: Tool<any>[] = [
	getPage,
	getPages,
	getPageHistory,
	getRecentChanges,
	searchPage,
	searchPageByPrefix,
	parseWikitext,
	comparePages,
	getFile,
	getRevision,
	getCategoryMembers,
	createPage,
	updatePage,
	deletePage,
	undeletePage,
	uploadFile,
	uploadFileFromUrl,
	updateFile,
	updateFileFromUrl,
];

// oxlint-disable-next-line typescript/no-explicit-any
export const managementTools: Tool<any, ManagementContext>[] = [addWiki, removeWiki, setWiki];

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
			logger.error('Error registering tool', { error: (error as Error).message });
		}
	}

	const mgmtCtx: ManagementContext = { ...ctx, reconcile };
	for (const tool of managementTools) {
		try {
			registered.set(tool.name, register(server, tool, dispatch(tool, mgmtCtx)));
		} catch (error) {
			logger.error('Error registering tool', { error: (error as Error).message });
		}
	}

	return registered;
}
