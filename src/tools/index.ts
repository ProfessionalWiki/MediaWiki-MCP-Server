/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

import { wikiService } from '../common/wikiService.js';

import { getPageTool } from './get-page.js';
import { getPagesTool } from './get-pages.js';
import { getPageHistoryTool } from './get-page-history.js';
import { searchPageTool } from './search-page.js';
import { setWikiTool, type OnActiveWikiChanged } from './set-wiki.js';
import { addWikiTool } from './add-wiki.js';
import { removeWikiTool } from './remove-wiki.js';
import { updatePageTool } from './update-page.js';
import { getFileTool } from './get-file.js';
import { createPageTool } from './create-page.js';
import { uploadFileTool } from './upload-file.js';
import { uploadFileFromUrlTool } from './upload-file-from-url.js';
import { deletePageTool } from './delete-page.js';
import { getRevisionTool } from './get-revision.js';
import { undeletePageTool } from './undelete-page.js';
import { getCategoryMembersTool } from './get-category-members.js';
import { searchPageByPrefixTool } from './search-page-by-prefix.js';
import { parseWikitextTool } from './parse-wikitext.js';
import { comparePagesTool } from './compare-pages.js';

type ToolRegistrar = ( server: McpServer ) => RegisteredTool;

// set-wiki is registered separately in registerAllTools because its
// signature will take additional arguments in a subsequent change.
const toolRegistrars: [ string, ToolRegistrar ][] = [
	[ 'get-page', getPageTool ],
	[ 'get-pages', getPagesTool ],
	[ 'get-page-history', getPageHistoryTool ],
	[ 'search-page', searchPageTool ],
	[ 'add-wiki', addWikiTool ],
	[ 'remove-wiki', removeWikiTool ],
	[ 'update-page', updatePageTool ],
	[ 'get-file', getFileTool ],
	[ 'create-page', createPageTool ],
	[ 'upload-file', uploadFileTool ],
	[ 'upload-file-from-url', uploadFileFromUrlTool ],
	[ 'delete-page', deletePageTool ],
	[ 'get-revision', getRevisionTool ],
	[ 'undelete-page', undeletePageTool ],
	[ 'get-category-members', getCategoryMembersTool ],
	[ 'search-page-by-prefix', searchPageByPrefixTool ],
	[ 'parse-wikitext', parseWikitextTool ],
	[ 'compare-pages', comparePagesTool ]
];

const wikiManagementRegistrars: Set<ToolRegistrar> = new Set( [ addWikiTool, removeWikiTool ] );

export function registerAllTools(
	server: McpServer,
	onActiveWikiChanged: OnActiveWikiChanged
): Map<string, RegisteredTool> {
	const registered = new Map<string, RegisteredTool>();
	const allowManagement = wikiService.isWikiManagementAllowed();

	for ( const [ name, registrar ] of toolRegistrars ) {
		try {
			const tool = registrar( server );
			if ( !allowManagement && wikiManagementRegistrars.has( registrar ) ) {
				tool.disable();
			}
			registered.set( name, tool );
		} catch ( error ) {
			console.error( `Error registering tool: ${ ( error as Error ).message }` );
		}
	}

	try {
		registered.set( 'set-wiki', setWikiTool( server, onActiveWikiChanged ) );
	} catch ( error ) {
		console.error( `Error registering tool: ${ ( error as Error ).message }` );
	}

	return registered;
}
