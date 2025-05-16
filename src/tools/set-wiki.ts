// TODO: Take any wiki URL and resolve it to the base URL
// TODO: Validate whether the wiki server is valid
// TODO: Discover article and script paths based on wiki server

import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { updateConfig, getConfig } from '../common/config.js';

export function setWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'set-wiki',
		'Set the wiki to use for the current session',
		{
			wikiServer: z.string().url().describe( 'The base URL of the MediaWiki installation (e.g., https://en.wikipedia.org).' ),
			articlePath: z.string().describe( 'The article path on the wiki. Defaults to "/wiki".' ).optional(),
			scriptPath: z.string().describe( 'The script path on the wiki. Defaults to "/w".' ).optional()
		},
		{
			title: 'Set wiki',
			destructiveHint: true
		} as ToolAnnotations,
		async ( args: {
			wikiServer: string;
			articlePath?: string;
			scriptPath?: string;
		} ): Promise<CallToolResult> => {
			updateConfig( {
				WIKI_SERVER: args.wikiServer,
				ARTICLE_PATH: args.articlePath,
				SCRIPT_PATH: args.scriptPath
			} );
			const newConfig = getConfig();
			return {
				content: [
					{
						type: 'text',
						text: `MediaWiki configuration updated.\nNew wiki: ${ newConfig.WIKI_SERVER }`
					} as TextContent
				]
			};
		}
	);
}
