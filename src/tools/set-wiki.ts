import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import type { WikiConfig } from '../common/config.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';

export type OnActiveWikiChanged = ( activeWiki: Readonly<WikiConfig> ) => void;

export function setWikiTool(
	server: McpServer,
	onActiveWikiChanged: OnActiveWikiChanged
): RegisteredTool {
	return server.tool(
		'set-wiki',
		'Selects the wiki to use for subsequent tool calls in this session. Required before interacting with a wiki that is not the configured default; the active wiki is consulted by every page, file, search, and history tool. Returns the new active wiki\'s sitename and server URL.',
		{
			uri: z.string().describe( 'MCP resource URI of the wiki to use (e.g. mcp://wikis/en.wikipedia.org)' )
		},
		{
			title: 'Set wiki',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		} as ToolAnnotations,
		( { uri } ) => handleSetWikiTool( uri, onActiveWikiChanged )
	);
}

async function handleSetWikiTool(
	uri: string,
	onActiveWikiChanged: OnActiveWikiChanged
): Promise<CallToolResult> {
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
		onActiveWikiChanged( newConfig );
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
