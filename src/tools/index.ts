/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

import { logger } from '../common/logger.js';

import { getPageTool } from './get-page.js';
import { getPagesTool } from './get-pages.js';
import { getPageHistoryTool } from './get-page-history.js';
import { searchPageTool } from './search-page.js';
import { setWikiTool } from './set-wiki.js';
import type { Reconcile } from '../runtime/reconcile.js';
import { addWikiTool } from './add-wiki.js';
import { removeWikiTool } from './remove-wiki.js';
import { updatePageTool } from './update-page.js';
import { getFileTool } from './get-file.js';
import { createPageTool } from './create-page.js';
import { uploadFileTool } from './upload-file.js';
import { uploadFileFromUrlTool } from './upload-file-from-url.js';
import { updateFileTool } from './update-file.js';
import { updateFileFromUrlTool } from './update-file-from-url.js';
import { deletePageTool } from './delete-page.js';
import { getRevisionTool } from './get-revision.js';
import { undeletePageTool } from './undelete-page.js';
import { getCategoryMembersTool } from './get-category-members.js';
import { getRecentChangesTool } from './get-recent-changes.js';
import { searchPageByPrefixTool } from './search-page-by-prefix.js';
import { parseWikitextTool } from './parse-wikitext.js';
import { comparePagesTool } from './compare-pages.js';

type ToolRegistrar = ( server: McpServer ) => RegisteredTool;

// add-wiki, remove-wiki, and set-wiki are registered separately in
// registerAllTools because each takes a reconcile callback.
const toolRegistrars: [ string, ToolRegistrar ][] = [
	[ 'get-page', getPageTool ],
	[ 'get-pages', getPagesTool ],
	[ 'get-page-history', getPageHistoryTool ],
	[ 'get-recent-changes', getRecentChangesTool ],
	[ 'search-page', searchPageTool ],
	[ 'update-page', updatePageTool ],
	[ 'get-file', getFileTool ],
	[ 'create-page', createPageTool ],
	[ 'upload-file', uploadFileTool ],
	[ 'upload-file-from-url', uploadFileFromUrlTool ],
	[ 'update-file', updateFileTool ],
	[ 'update-file-from-url', updateFileFromUrlTool ],
	[ 'delete-page', deletePageTool ],
	[ 'get-revision', getRevisionTool ],
	[ 'undelete-page', undeletePageTool ],
	[ 'get-category-members', getCategoryMembersTool ],
	[ 'search-page-by-prefix', searchPageByPrefixTool ],
	[ 'parse-wikitext', parseWikitextTool ],
	[ 'compare-pages', comparePagesTool ]
];

export function registerAllTools(
	server: McpServer,
	reconcile: Reconcile
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();

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
