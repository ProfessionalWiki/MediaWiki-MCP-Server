import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { discoverWiki } from '../common/wikiDiscovery.js';

export function addWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'add-wiki',
		'Adds a new wiki to the MCP resources from a URL.',
		{
			wikiUrl: z.string().url().describe( 'Any URL from the target wiki (e.g. https://en.wikipedia.org/wiki/Main_Page)' )
		},
		{
			title: 'Add wiki',
			destructiveHint: true
		} as ToolAnnotations,
		( { wikiUrl } ) => handleAddWikiTool( server, wikiUrl )
	);
}

async function handleAddWikiTool( server: McpServer, wikiUrl: string ): Promise<CallToolResult> {
	const wikiInfo = await discoverWiki( wikiUrl );

	if ( wikiInfo === null ) {
		return {
			content: [
				{
					type: 'text',
					text: 'Failed to determine wiki info. Please ensure the URL is correct and the wiki is accessible.'
				} as TextContent
			],
			isError: true
		};
	}

	try {
		const newConfig = {
			sitename: wikiInfo.sitename,
			server: wikiInfo.server,
			articlepath: wikiInfo.articlepath,
			scriptpath: wikiInfo.scriptpath,
			token: null,
			private: false
		};

		wikiService.add( wikiInfo.servername, newConfig );
		server.sendResourceListChanged();

		return {
			content: [
				{
					type: 'text',
					text: `${ wikiInfo.sitename } (mcp://wikis/${ wikiInfo.servername }) has been added to MCP resources.`
				} as TextContent
			]
		};
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Failed to add wiki: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}
}
