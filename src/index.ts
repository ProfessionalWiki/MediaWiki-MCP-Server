#!/usr/bin/env node

// Under stdio transport, stdout IS the JSON-RPC channel. Some dependencies
// (notably mwn's request-retry logger, node_modules/mwn/build/core.js's
// logError()) write diagnostics straight to console.log/stdout on a
// retriable request failure (network hiccup, 5xx, timeout) — one stray
// write splices a raw, multi-line, non-JSON object into the message stream
// and corrupts the client's line-based parser. Redirect console.log/info/
// debug to stderr before any dependency code can run. Harmless under HTTP
// transport, where stdout isn't a protocol channel, so this is skipped there.
export function silenceStdoutLogging(): void {
	console.log = (...args) => console.error(...args);
	console.info = console.log;
	console.debug = console.log;
}

async function main(): Promise<void> {
	const transportType = process.env.MCP_TRANSPORT || 'stdio';
	if (transportType === 'http') {
		await import('./transport/streamableHttp.js');
	} else {
		silenceStdoutLogging();
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
