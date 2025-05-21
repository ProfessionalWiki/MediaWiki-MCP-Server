/* eslint-disable n/no-missing-import */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

export const SERVER_NAME: string = 'mediawiki-mcp-server';
export const SERVER_VERSION: string = '0.0.0';

export const server = new McpServer( {
	name: SERVER_NAME,
	version: SERVER_VERSION
} );
