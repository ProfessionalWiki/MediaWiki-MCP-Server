import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getCurrentWikiConfig, setCurrentWiki } from '../common/config.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

export function setWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'set-wiki',
		'Set the wiki to use for the current session.',
		{
			wikiUrl: z.string().url().describe( 'Any URL from the target wiki (e.g. https://en.wikipedia.org/wiki/Main_Page).' )
		},
		{
			title: 'Set wiki',
			destructiveHint: true
		} as ToolAnnotations,
		async ( args: {
			wikiUrl: string;
		} ): Promise<CallToolResult> => {
			try {
				const wiki = await resolveWiki( args.wikiUrl );
				setCurrentWiki( wiki );
				const newConfig = getCurrentWikiConfig();
				return {
					content: [ {
						type: 'text',
						text: `Wiki set to ${ newConfig.sitename } (${ newConfig.server })`
					} as TextContent ]
				};
			} catch ( error ) {
				if ( error instanceof WikiDiscoveryError ) {
					return {
						content: [ { type: 'text', text: error.message } as TextContent ],
						isError: true
					};
				}
				return {
					content: [ {
						type: 'text',
						text: `An unexpected error occurred: ${ ( error as Error ).message }`
					} as TextContent ],
					isError: true
				};
			}
		}
	);
}
