/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

import { logger } from '../common/logger.js';

import { getPageTool } from './get-page.js';
import { getPagesTool } from './get-pages.js';
import { getPageHistory } from './get-page-history.js';
import { searchPage } from './search-page.js';
import { setWikiTool } from './set-wiki.js';
import type { Reconcile } from '../runtime/reconcile.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { dispatch } from '../runtime/dispatcher.js';
import { register } from '../runtime/register.js';
import { addWikiTool } from './add-wiki.js';
import { removeWikiTool } from './remove-wiki.js';
import { updatePageTool } from './update-page.js';
import { getFile } from './get-file.js';
import { createPageTool } from './create-page.js';
import { uploadFileTool } from './upload-file.js';
import { uploadFileFromUrlTool } from './upload-file-from-url.js';
import { updateFileTool } from './update-file.js';
import { updateFileFromUrlTool } from './update-file-from-url.js';
import { deletePage } from './delete-page.js';
import { getRevision } from './get-revision.js';
import { undeletePageTool } from './undelete-page.js';
import { getCategoryMembers } from './get-category-members.js';
import { getRecentChanges } from './get-recent-changes.js';
import { searchPageByPrefix } from './search-page-by-prefix.js';
import { parseWikitext } from './parse-wikitext.js';
import { comparePagesTool } from './compare-pages.js';

type ToolRegistrar = ( server: McpServer ) => RegisteredTool;

// Tools migrated to the new descriptor + dispatcher shape.
// `Tool<any>` widens the heterogeneous-schema array; `inputSchema: TSchema`
// is invariant in `TSchema`, so `Tool<never>` and `Tool<ZodRawShape>` both
// fail this assignment. The dispatcher's own generic re-narrows TSchema
// when each tool's handler is wrapped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const standardTools: Tool<any>[] = [
	deletePage,
	getFile,
	getRevision,
	getCategoryMembers,
	searchPage,
	searchPageByPrefix,
	getPageHistory,
	parseWikitext,
	getRecentChanges
];

// add-wiki, remove-wiki, and set-wiki are registered separately in
// registerAllTools because each takes a reconcile callback.
const toolRegistrars: [ string, ToolRegistrar ][] = [
	[ 'get-page', getPageTool ],
	[ 'get-pages', getPagesTool ],
	[ 'update-page', updatePageTool ],
	[ 'create-page', createPageTool ],
	[ 'upload-file', uploadFileTool ],
	[ 'upload-file-from-url', uploadFileFromUrlTool ],
	[ 'update-file', updateFileTool ],
	[ 'update-file-from-url', updateFileFromUrlTool ],
	[ 'undelete-page', undeletePageTool ],
	[ 'compare-pages', comparePagesTool ]
];

export function registerAllTools(
	server: McpServer,
	reconcile: Reconcile,
	ctx: ToolContext
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();

	// Migrated tools: descriptor + dispatcher.
	for ( const tool of standardTools ) {
		try {
			registered.set( tool.name, register( server, tool, dispatch( tool, ctx ) ) );
		} catch ( error ) {
			logger.error( 'Error registering tool', { error: ( error as Error ).message } );
		}
	}

	// Legacy registrars (migrate one-by-one in subsequent tasks).
	for ( const [ name, registrar ] of toolRegistrars ) {
		try {
			registered.set( name, registrar( server ) );
		} catch ( error ) {
			logger.error( 'Error registering tool', { error: ( error as Error ).message } );
		}
	}

	try {
		registered.set( 'add-wiki', addWikiTool( server, reconcile ) );
	} catch ( error ) {
		logger.error( 'Error registering tool', { error: ( error as Error ).message } );
	}

	try {
		registered.set( 'remove-wiki', removeWikiTool( server, reconcile ) );
	} catch ( error ) {
		logger.error( 'Error registering tool', { error: ( error as Error ).message } );
	}

	try {
		registered.set( 'set-wiki', setWikiTool( server, reconcile ) );
	} catch ( error ) {
		logger.error( 'Error registering tool', { error: ( error as Error ).message } );
	}

	return registered;
}
