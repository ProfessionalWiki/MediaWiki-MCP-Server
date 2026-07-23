#!/usr/bin/env node

async function main(): Promise<void> {
	// Before anything can log: stdout belongs to the stdio transport, and a
	// dependency writing there corrupts the JSON-RPC stream. Imported
	// dynamically like the transports below so a failure here still reaches the
	// fail-safe handler rather than escaping as a module-load error.
	const { guardStdout } = await import('./runtime/stdoutGuard.js');
	guardStdout();

	const transportType = process.env.MCP_TRANSPORT || 'stdio';
	if (transportType === 'http') {
		const { startHttpServer } = await import('./transport/streamableHttp.js');
		startHttpServer();
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
