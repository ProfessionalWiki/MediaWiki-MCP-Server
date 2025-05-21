/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */

import { server } from './server.js';
import { registerAllTools } from './tools/index.js';

async function main(): Promise<void> {
	registerAllTools( server );

	const transport = new StdioServerTransport();
	await server.connect( transport );
}

main().catch( ( error ) => {
	console.error( 'Fatal error in main():', error );
	throw error;
} );
