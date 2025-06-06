/* eslint-disable n/no-missing-import */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { createRequire } from 'node:module';
import { registerAllTools } from './tools/index.js';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
const packageInfo = createRequire( import.meta.url )( '../package.json' ) as { version: string };

const SERVER_NAME: string = 'mediawiki-mcp-server';
const SERVER_VERSION: string = packageInfo.version;

export const createServer = (): McpServer => {
	const server = new McpServer( {
		name: SERVER_NAME,
		version: SERVER_VERSION
	} );

	registerAllTools( server );

	return server;
};

export const USER_AGENT: string = `${ SERVER_NAME }/${ SERVER_VERSION }`;
