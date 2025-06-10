/* eslint-disable n/no-missing-import */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { packageJSON } from './package.js';
import { registerAllTools } from './tools/index.js';

const SERVER_NAME: string = 'mediawiki-mcp-server';
const SERVER_VERSION: string = packageJSON.version;

export const createServer = (): McpServer => {
	const server = new McpServer( {
		name: SERVER_NAME,
		version: SERVER_VERSION
	} );

	registerAllTools( server );

	return server;
};

export const USER_AGENT: string = `${ SERVER_NAME }/${ SERVER_VERSION }`;
