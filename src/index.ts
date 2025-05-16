/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */

// TODO: Register tools in a way that is easier to manage
import { searchPageTool } from './tools/search-page.js';
import { server } from './server.js';

// Register tools
searchPageTool( server );

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
