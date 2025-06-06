#!/usr/bin/env node

/* eslint-disable n/no-missing-import */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
/* eslint-enable n/no-missing-import */
import { createServer } from './server.js';

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	const server = createServer();

	await server.connect( transport );
}

main().catch( ( error ) => {
	console.error( 'Server error:', error );
	throw error;
} );
