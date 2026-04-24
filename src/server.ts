/* eslint-disable n/no-missing-import */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { createRequire } from 'node:module';
import { wikiService } from './common/wikiService.js';
import type { WikiConfig } from './common/config.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { reconcileToolsForActiveWiki } from './tools/reconcile.js';

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

export const createServer = (): McpServer => {
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
				}
			},
			instructions: SERVER_INSTRUCTIONS
		}
	);

	const tools = new Map<string, RegisteredTool>();
	const reconcile = ( wiki: Readonly<WikiConfig> ): void => {
		reconcileToolsForActiveWiki( tools, wiki );
	};

	const registered = registerAllTools( server, reconcile );
	for ( const [ name, tool ] of registered ) {
		tools.set( name, tool );
	}
	registerAllResources( server );

	reconcile( wikiService.getCurrent().config );

	return server;
};

export const USER_AGENT: string = `${ SERVER_NAME }/${ serverInfo.version }`;
