#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { logger } from '../runtime/logger.ts';
import { createServer } from '../server.ts';
import { emitStartupBanner } from '../runtime/banner.ts';
import { createToolContext } from '../runtime/createContext.ts';
import { registerShutdownHandlers } from '../runtime/shutdown.ts';
import { loadConfigFromFile } from '../config/loadConfig.ts';
import { createAppState } from '../wikis/state.ts';

async function main(): Promise<void> {
	const config = loadConfigFromFile();
	const state = createAppState(config);
	emitStartupBanner(
		{ transport: 'stdio' },
		{
			wikiRegistry: state.wikiRegistry,
			activeWiki: state.activeWiki,
			uploadDirs: state.uploadDirs,
		},
	);
	const ctx = createToolContext({ logger, state, transport: 'stdio' });

	// serveStdio owns the connection: the opening exchange pins the era, one
	// instance from the factory serves the connection's lifetime, and on a
	// modern-pinned connection the entry rewrites outbound change
	// notifications onto its subscriptions/listen streams — so the default
	// change publisher in createServer covers both eras here.
	const handle = serveStdio(() => createServer(ctx), {
		onerror: (error) => logger.error(`stdio serving error: ${error.message}`),
	});

	// Stdio has no in-flight queue, so grace doesn't apply — log graceMs: 0
	// to make that explicit in the shutdown event.
	registerShutdownHandlers({
		transport: 'stdio',
		graceMs: 0,
		stdioTransport: handle,
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
