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
	// Bootstrap fail-safe: the logger module may itself be unimportable here
	// (transitive failure during boot). Stay on console.error so this last-
	// resort path always works.
	console.error( 'Fatal error in main():', error );
	throw error;
} );
