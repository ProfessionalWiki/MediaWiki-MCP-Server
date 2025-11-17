import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { clearMwnCache } from '../common/mwn.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';

export function removeWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'remove-wiki',
		'Removes a wiki from the MCP resources.',
		{
			uri: z.string().describe( 'MCP resource URI of the wiki to remove (e.g. mcp://wikis/en.wikipedia.org)' )
		},
		{
			title: 'Remove wiki',
			destructiveHint: true
		} as ToolAnnotations,
		( { uri } ) => handleRemoveWikiTool( server, uri )
	);
}

async function handleRemoveWikiTool( server: McpServer, uri: string ): Promise<CallToolResult> {
	try {
		const { wikiKey } = parseWikiResourceUri( uri );

		const wikiToRemove = wikiService.get( wikiKey );
		if ( !wikiToRemove ) {
			return {
				content: [ {
					type: 'text',
					text: `mcp://wikis/${ wikiKey } not found in MCP resources.`
				} as TextContent ],
				isError: true
			};
		}

		if ( wikiService.getCurrent().key === wikiKey ) {
			return {
				content: [ {
					type: 'text',
					text: 'Cannot remove the currently active wiki. Please set a different wiki as the active wiki before removing this one.'
				} as TextContent ],
				isError: true
			};
		}

		wikiService.remove( wikiKey );
		server.sendResourceListChanged();
		clearMwnCache();

		return {
			content: [ {
				type: 'text',
				text: `${ wikiToRemove.sitename } (mcp://wikis/${ wikiKey }) has been removed from MCP resources.`
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
