/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */

import { server } from './server.js';

// TODO: Register tools in a way that is easier to manage
import { searchPageTool } from './tools/search-page.js';
import { setWikiTool } from './tools/set-wiki.js';
import { getPageTool } from './tools/get-page.js';

// Register tools
setWikiTool( server );
searchPageTool( server );
getPageTool( server );

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect( transport );

	server.server.sendLoggingMessage( {
		level: 'debug',
		data: 'MediaWiki MCP Server running on stdio'
	} );
}

main().catch( ( error ) => {
	console.error( 'Fatal error in main():', error );
	throw error;
} );
