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
	const ctx = createToolContext({ logger, state });
	const server = createServer(ctx);

	await server.connect(transport);
	registerShutdownHandlers({
		transport: 'stdio',
		graceMs: 0,
		stdioTransport: transport,
	});
}

main().catch((error) => {
	console.error('Server error:', error);
	throw error;
});
