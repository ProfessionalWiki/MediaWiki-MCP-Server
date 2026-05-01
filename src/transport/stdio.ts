#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../runtime/logger.js';
import { createServer } from '../server.js';
import { emitStartupBanner } from '../runtime/banner.js';
import { createToolContext } from '../runtime/createContext.js';
import { registerShutdownHandlers } from '../runtime/shutdown.js';
import { loadConfigFromFile } from '../config/loadConfig.js';
import { createAppState } from '../wikis/state.js';

async function main(): Promise<void> {
	const config = loadConfigFromFile();
	const state = createAppState(config);
	emitStartupBanner(
		{ transport: 'stdio' },
		{
			wikiRegistry: state.wikiRegistry,
			wikiSelection: state.wikiSelection,
			uploadDirs: state.uploadDirs,
		},
	);
	const transport = new StdioServerTransport();
	const ctx = createToolContext({ logger, state, transport: 'stdio' });
	const server = await createServer(ctx);

	await server.connect(transport);
	// Stdio has no in-flight queue, so grace doesn't apply — log graceMs: 0
	// to make that explicit in the shutdown event.
	registerShutdownHandlers({
		transport: 'stdio',
		graceMs: 0,
		stdioTransport: transport,
	});
}

main().catch((error) => {
	// Bootstrap fail-safe: see the equivalent block in src/index.ts. Logger
	// module not used here intentionally so a logger import failure can't
	// suppress this path. Exit cleanly instead of re-throwing — `throw` from
	// inside .catch creates a detached promise chain that fires as an
	// unhandled-rejection warning on top of our own message.
	console.error('Server error:', error);
	process.exit(1);
});
