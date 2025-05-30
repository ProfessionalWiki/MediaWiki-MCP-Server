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

const toolRegistrars = [
	getPageTool,
	getPageHistoryTool,
	searchPageTool,
	setWikiTool,
	updatePageTool,
	getFileTool,
	createPageTool,
];

export function registerAllTools( server: McpServer ): RegisteredTool[] {
	const registeredTools: RegisteredTool[] = [];
	for ( const registrar of toolRegistrars ) {
		try {
			registeredTools.push( registrar( server ) );
		} catch ( error ) {}
	}
	return registeredTools;
}
