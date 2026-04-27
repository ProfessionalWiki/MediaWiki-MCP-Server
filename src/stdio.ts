#!/usr/bin/env node

/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */
import { createServer, emitStartupBanner } from './server.js';

async function main(): Promise<void> {
	emitStartupBanner( { transport: 'stdio' } );
	const transport = new StdioServerTransport();
	const server = createServer( { transport: 'stdio' } );

	await server.connect( transport );
}

main().catch( ( error ) => {
	// Bootstrap fail-safe: see the equivalent block in src/index.ts. Logger
	// module not used here intentionally so a logger import failure can't
	// suppress this path.
	console.error( 'Server error:', error );
	throw error;
} );
