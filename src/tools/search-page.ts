// TODO: Make tools into an interface
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeApiRequest } from '../common/utils.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResultObject } from '../types/mwRestApi.js';
import { WIKI_SERVER, ARTICLE_PATH, SCRIPT_PATH } from '../common/config.js';

// TODO: Decide how to register the tool
export function searchPageTool( server: McpServer ): RegisteredTool {
	// TODO: Not having named parameters is a pain,
	// but using low-level Server type or using a wrapper function are addedd complexity
	return server.tool(
		'search-page',
		'Search for a wiki page',
		{
			query: z.string().describe( 'The query to search for' )
		},
		{
			title: 'Search page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { query } ) => handleSearchPageTool( query )
	);
}

async function handleSearchPageTool( query: string ): Promise< CallToolResult > {
	const url = `${ WIKI_SERVER() }${ SCRIPT_PATH() }/rest.php/v1/search/page`;
	const data = await makeApiRequest<MwRestApiSearchPageResponse>(
		url, { q: query, limit: '10' }
	);

	if ( !data ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to retrieve search data' } as TextContent
			],
			isError: true
		};
	}

	const pages = data.pages || [];
	if ( pages.length === 0 ) {
		return {
			content: [
				{ type: 'text', text: `No pages found for ${ query }` } as TextContent
			]
		};
	}

	return {
		content: pages.map( getSearchResultToolResult )
	};
}

// TODO: Decide how to handle the tool's result
function getSearchResultToolResult( result: MwRestApiSearchResultObject ): TextContent {
	return {
		type: 'text',
		text: [
			`Title: ${ result.title }`,
			`Description: ${ result.description ?? 'Not available' }`,
			`Thumbnail: ${ result.thumbnail?.url ?? 'Not available' }`,
			`Page ID: ${ result.id }`,
			`URL: ${ `${ WIKI_SERVER() }${ ARTICLE_PATH() }/${ result.key }` }`
		].join( '\n' )
	};
}
