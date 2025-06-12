// TODO: Make tools into an interface
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiServer, articlePath } from '../common/config.js';
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResultObject } from '../types/mwRestApi.js';

export function searchPageTool( server: McpServer ): RegisteredTool {
	// TODO: Not having named parameters is a pain,
	// but using low-level Server type or using a wrapper function are addedd complexity
	return server.tool(
		'search-page',
		'Search wiki page titles and contents for the provided search terms, and returns matching pages.',
		{
			query: z.string().describe( 'Search terms' ),
			limit: z.number().describe( 'Maximum number of search results to return (1-100)' ).min( 1 ).max( 100 ).optional()
		},
		{
			title: 'Search page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { query, limit } ) => handleSearchPageTool( query, limit )
	);
}

async function handleSearchPageTool( query: string, limit?: number ): Promise< CallToolResult > {
	let data: MwRestApiSearchPageResponse | null = null;
	try {
		data = await makeRestGetRequest<MwRestApiSearchPageResponse>(
			'/v1/search/page',
			{ q: query, ...( limit ? { limit: limit.toString() } : {} ) }
		);
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve search data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	if ( data === null ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to retrieve search data: No data returned from API' } as TextContent
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
			`Page ID: ${ result.id }`,
			`Page URL: ${ `${ wikiServer() }${ articlePath() }/${ result.key }` }`,
			`Thumbnail URL: ${ result.thumbnail?.url ?? 'Not available' }`
		].join( '\n' )
	};
}
