#!/usr/bin/env node

async function main(): Promise<void> {
	const transportType = process.env.MCP_TRANSPORT || 'stdio';
	if (transportType === 'http') {
		await import('./transport/streamableHttp.js');
	} else {
		await import('./transport/stdio.js');
	}
}

main().catch((error) => {
	// Bootstrap fail-safe: the logger module may itself be unimportable here
	// (transitive failure during boot). Stay on console.error so this last-
	// resort path always works. Re-throwing here would create a detached
	// promise chain (the .catch derivative) and surface as an unhandled
	// rejection on top of our own error message — exit cleanly instead.
	console.error('Fatal error in main():', error);
	process.exit(1);
});
