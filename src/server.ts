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
const packageInfo = createRequire( import.meta.url )( '../package.json' ) as { version: string };

const SERVER_NAME: string = 'mediawiki-mcp-server';
const SERVER_VERSION: string = packageInfo.version;

export const createServer = (): McpServer => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			version: SERVER_VERSION
		},
		{
			capabilities: {
				resources: {
					listChanged: true
				},
				tools: {
					listChanged: true
				}
			}
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

export const USER_AGENT: string = `${ SERVER_NAME }/${ SERVER_VERSION }`;
