/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

import { getPageTool } from './get-page.js';
import { getPageHistoryTool } from './get-page-history.js';
import { searchPageTool } from './search-page.js';
import { setWikiTool } from './set-wiki.js';
import { updatePageTool } from './update-page.js';
import { getFileTool } from './get-file.js';
import { createPageTool } from './create-page.js';
import { uploadFileTool } from './upload-file.js';
import { uploadFileFromUrlTool } from './upload-file-from-url.js';
import { deletePageTool } from './delete-page.js';
import { getRevisionTool } from './get-revision.js';
import { undeletePageTool } from './undelete-page.js';
import { getCategoryMembersTool } from './get-category-members.js';

const toolRegistrars = [
	getPageTool,
	getPageHistoryTool,
	searchPageTool,
	setWikiTool,
	updatePageTool,
	getFileTool,
	createPageTool,
	uploadFileTool,
	uploadFileFromUrlTool,
	deletePageTool,
	getRevisionTool,
	undeletePageTool,
	getCategoryMembersTool
];

export function registerAllTools( server: McpServer ): RegisteredTool[] {
	const registeredTools: RegisteredTool[] = [];
	for ( const registrar of toolRegistrars ) {
		try {
			registeredTools.push( registrar( server ) );
		} catch ( error ) {
			console.error( `Error registering tool: ${ ( error as Error ).message }` );
		}
	}
	return registeredTools;
}
