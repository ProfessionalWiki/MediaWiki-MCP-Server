import type { Tool } from '../runtime/tool.ts';
import { extensionPacks } from './extensions/index.ts';

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
import { createPage } from './create-page.ts';
import { updatePage } from './update-page.ts';
import { movePage } from './move-page.ts';
import { deletePage } from './delete-page.ts';
import { undeletePage } from './undelete-page.ts';
import { protectPage } from './protect-page.ts';
import { uploadFile } from './upload-file.ts';
import { uploadFileFromUrl } from './upload-file-from-url.ts';
import { updateFile } from './update-file.ts';
import { updateFileFromUrl } from './update-file-from-url.ts';
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
	protectPage,
	uploadFile,
	uploadFileFromUrl,
	updateFile,
	updateFileFromUrl,
	oauthStatus,
	oauthLogout,
];

// Every tool that runs with a ToolContext, standard and extension-pack alike.
// registerAllTools registers this list and the read-only gate reads it, so the
// two cannot disagree.
// oxlint-disable-next-line typescript/no-explicit-any
export const allStandardTools: Tool<any>[] = [
	...standardTools,
	...extensionPacks.flatMap((pack) => pack.tools),
];
