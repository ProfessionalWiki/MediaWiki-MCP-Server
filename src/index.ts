#!/usr/bin/env node

async function main(): Promise<void> {
	const transportType = process.env.MCP_TRANSPORT || 'stdio';
	if ( transportType === 'http' ) {
		await import( './streamableHttp.js' );
	} else {
		await import( './stdio.js' );
	}
}

main().catch( ( error ) => {
	console.error( 'Fatal error in main():', error );
	throw error;
} );
