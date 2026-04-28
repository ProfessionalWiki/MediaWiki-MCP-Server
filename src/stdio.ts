#!/usr/bin/env node

/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */
import { logger } from './common/logger.js';
import { createServer } from './server.js';
import { createToolContext } from './runtime/createContext.js';

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	const ctx = createToolContext( { logger } );
	const server = createServer( ctx );

	await server.connect( transport );
}

main().catch( ( error ) => {
	// Bootstrap fail-safe: see the equivalent block in src/index.ts. Logger
	// module not used here intentionally so a logger import failure can't
	// suppress this path.
	console.error( 'Server error:', error );
	throw error;
} );
