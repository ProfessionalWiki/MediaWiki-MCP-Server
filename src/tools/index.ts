import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { errorMessage } from '../errors/isErrnoException.ts';
import { logger } from '../runtime/logger.ts';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext, ManagementContext } from '../runtime/context.ts';
import type { Reconcile } from '../runtime/reconcile.ts';
import { dispatch } from '../runtime/dispatcher.ts';
import { register } from '../runtime/register.ts';

import { getPage } from './get-page.ts';
import { getPages } from './get-pages.ts';
import { getPageHistory } from './get-page-history.ts';
import { getRecentChanges } from './get-recent-changes.ts';
import { searchPage } from './search-page.ts';
import { searchPageByPrefix } from './search-page-by-prefix.ts';
import { parseWikitext } from './parse-wikitext.ts';
import { comparePages } from './compare-pages.ts';
import { getFile } from './get-file.ts';
import { getFileData } from './get-file-data.ts';
import { getRevision } from './get-revision.ts';
import { getSiteInfo } from './get-site-info.ts';
import { getCategoryMembers } from './get-category-members.ts';
import { getLinksHere } from './get-links-here.ts';
import { listWikis } from './list-wikis.ts';
import { whoami } from './whoami.ts';
import { extensionPacks } from './extensions/index.ts';
import { createPage } from './create-page.ts';
import { updatePage } from './update-page.ts';
import { movePage } from './move-page.ts';
import { deletePage } from './delete-page.ts';
import { undeletePage } from './undelete-page.ts';
import { uploadFile } from './upload-file.ts';
import { uploadFileFromUrl } from './upload-file-from-url.ts';
import { updateFile } from './update-file.ts';
import { updateFileFromUrl } from './update-file-from-url.ts';
import { addWiki } from './add-wiki.ts';
import { removeWiki } from './remove-wiki.ts';
import { oauthStatus } from './oauth-status.ts';
import { oauthLogout } from './oauth-logout.ts';

// `Tool<any>` widens the heterogeneous-schema array; `inputSchema: TSchema`
// is invariant in `TSchema`, so `Tool<never>` and `Tool<ZodRawShape>` both
// fail this assignment. The dispatcher's own generic re-narrows TSchema
// when each tool's handler is wrapped.
// oxlint-disable-next-line typescript/no-explicit-any
const standardTools: Tool<any>[] = [
	getPage,
	getPages,
	getPageHistory,
	getRecentChanges,
	searchPage,
	searchPageByPrefix,
	parseWikitext,
	comparePages,
	getFile,
	getFileData,
	getRevision,
	getSiteInfo,
	getCategoryMembers,
	getLinksHere,
	listWikis,
	whoami,
	createPage,
	updatePage,
	movePage,
	deletePage,
	undeletePage,
	uploadFile,
	uploadFileFromUrl,
	updateFile,
	updateFileFromUrl,
	oauthStatus,
	oauthLogout,
];

// oxlint-disable-next-line typescript/no-explicit-any
const managementTools: Tool<any, ManagementContext>[] = [addWiki, removeWiki];

export function registerAllTools(
	server: McpServer,
	reconcile: Reconcile,
	ctx: ToolContext,
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();

	// oxlint-disable-next-line typescript/no-explicit-any
	const allStandardTools: Tool<any>[] = [
		...standardTools,
		...extensionPacks.flatMap((p) => p.tools),
	];
	for (const tool of allStandardTools) {
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
