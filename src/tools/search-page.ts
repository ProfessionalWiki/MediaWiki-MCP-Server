// TODO: Make tools into an interface

/* eslint-disable n/no-missing-import */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { z } from 'zod';
import { makeApiRequest } from '../common/utils.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResult } from '../types/mwRestApiSearch.js';
import { WIKI_SERVER, ARTICLE_PATH, SCRIPT_PATH } from '../config.js';

// TODO: Decide how to register the tool
export function searchPageTool( server: McpServer ): void {
	server.tool(
		'search-page',
		'Search for a page on the wiki',
		{
			query: z.string().describe( 'The query to search for' )
		},
		async ( { query } ) => handleSearchPageTool( query )
	);
}

async function handleSearchPageTool( query: string ): Promise< CallToolResult > {
	const searchUrl = `${ WIKI_SERVER }${ SCRIPT_PATH }/rest.php/v1/search/page`;
	const searchData = await makeApiRequest<MwRestApiSearchPageResponse>(
		searchUrl, { q: query, limit: '10' }
	);

	if ( !searchData ) {
		return {
			content: [
				/** @type {TextContent} */
				{ type: 'text', text: 'Failed to retrieve search data' }
			]
		};
	}

	const pages = searchData.pages || [];
	if ( pages.length === 0 ) {
		return {
			content: [
				/** @type {TextContent} */
				{ type: 'text', text: `No pages found for ${ query }` }
			]
		};
	}

	return {
		content: pages.map( getSearchResultToolResult )
	};
}

// TODO: Decide how to handle the tool's result
function getSearchResultToolResult( result: MwRestApiSearchResult ): TextContent {
	return {
		type: 'text',
		text: [
			`Title: ${ result.title }`,
			`Description: ${ result.description ?? 'Not available' }`,
			`Thumbnail: ${ result.thumbnail?.url ?? 'Not available' }`,
			`Page ID: ${ result.id }`,
			`URL: ${ `${ WIKI_SERVER }${ ARTICLE_PATH }/${ result.key }` }`
		].join( '\n' )
	};
}
