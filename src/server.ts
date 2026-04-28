/* eslint-disable n/no-missing-import */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { createRequire } from 'node:module';
import { registerServer, unregisterServer } from './common/logger.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { reconcileTools } from './runtime/reconcile.js';
import type { ToolContext } from './runtime/context.js';

// USER_AGENT lives in a leaf module so wiki/mwn code can import it without
// transitively pulling in tools/* (which would create a wikiService ↔ tools
// import cycle through state.ts).
export { USER_AGENT } from './common/userAgent.js';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
const serverInfo = createRequire( import.meta.url )( '../server.json' ) as {
	title: string;
	description: string;
	version: string;
};

const SERVER_NAME: string = 'mediawiki-mcp-server';

const SERVER_INSTRUCTIONS: string = `Tools and resources for working with one or more MediaWiki wikis. Each configured wiki appears as an \`mcp://wikis/{wikiKey}\` resource. Tool calls target the currently selected wiki; pass an \`mcp://wikis/{wikiKey}\` URI to \`set-wiki\` to switch, and the selection persists until changed.

Writes, deletes, and uploads use the caller's \`Authorization: Bearer\` token when present, falling back to credentials configured on the active wiki.

Tool errors fall into seven categories: \`not_found\`, \`permission_denied\`, \`invalid_input\`, \`conflict\`, \`authentication\`, \`rate_limited\`, and \`upstream_failure\`. Reads that exceed a per-call cap return a truncation marker describing what was returned and how to fetch the rest.`;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const createServer = ( _ctx: ToolContext ): McpServer => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			title: serverInfo.title,
			version: serverInfo.version,
			description: serverInfo.description
		},
		{
			capabilities: {
				resources: {
					listChanged: true
				},
				tools: {
					listChanged: true
				},
				logging: {}
			},
			instructions: SERVER_INSTRUCTIONS
		}
	);

	registerServer( server );
	// The SDK transport only fires onclose on DELETE / explicit transport.close()
	// / process termination — not on a raw HTTP disconnect. So this registry
	// drains on the same lifecycle as the existing sessions map in
	// streamableHttp.ts; long-lived stale sessions persist until DELETE arrives
	// or the process ends. Acceptable because sendLoggingMessage to a closed
	// transport rejects, and swallowNotificationError absorbs that quietly.
	const previousOnClose = server.server.onclose;
	server.server.onclose = (): void => {
		unregisterServer( server );
		previousOnClose?.();
	};

	const tools = new Map<string, RegisteredTool>();
	const reconcile = (): void => reconcileTools( tools );

	const registered = registerAllTools( server, reconcile );
	for ( const [ name, tool ] of registered ) {
		tools.set( name, tool );
	}
	registerAllResources( server );

	reconcile();

	return server;
};

