import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';

export function setWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'set-wiki',
		'Sets the wiki to use for the current session. You MUST call this tool when interacting with a new wiki.',
		{
			uri: z.string().describe( 'MCP resource URI of the wiki to use (e.g. mcp://wikis/en.wikipedia.org)' )
		},
		{
			title: 'Set wiki',
			destructiveHint: true
		} as ToolAnnotations,
		( { uri } ) => handleSetWikiTool( uri )
	);
}

async function handleSetWikiTool( uri: string ): Promise<CallToolResult> {
	try {
		const { wikiKey } = parseWikiResourceUri( uri );

		if ( !wikiService.get( wikiKey ) ) {
			return {
				content: [ {
					type: 'text',
					text: `mcp://wikis/${ wikiKey } not found in MCP resources.`
				} as TextContent ],
				isError: true
			};
		}

		wikiService.setCurrent( wikiKey );

		const newConfig = wikiService.getCurrent().config;
		return {
			content: [ {
				type: 'text',
				text: `Wiki set to ${ newConfig.sitename } (${ newConfig.server })`
			} as TextContent ]
		};
	} catch ( error ) {
		if ( error instanceof InvalidWikiResourceUriError ) {
			return {
				content: [ {
					type: 'text',
					text: error.message
				} as TextContent ],
				isError: true
			};
		}
		throw error;
	}
}
