/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */

// TODO: Register tools in a way that is easier to manage
import { registerSearchPageTool } from './tools/search-page.js';
import { server } from './server.js';

// TODO: Make this configurable and perhaps move to a config file
const API_BASE: string = 'https://en.wikipedia.org/w';

// Register tools
registerSearchPageTool( server, API_BASE );

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
