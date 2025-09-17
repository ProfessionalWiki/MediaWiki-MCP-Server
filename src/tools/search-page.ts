// TODO: Make tools into an interface
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiServer, articlePath, getCurrentWikiKey, setCurrentWiki } from '../common/config.js';
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResultObject } from '../types/mwRestApi.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

export function searchPageTool( server: McpServer ): RegisteredTool {
	// TODO: Not having named parameters is a pain,
	// but using low-level Server type or using a wrapper function are addedd complexity
	return server.tool(
		'search-page',
		'Search wiki page titles and contents for the provided search terms, and returns matching pages.',
		{
			query: z.string().describe( 'Search terms' ),
			limit: z.number().describe( 'Maximum number of search results to return (1-100)' ).min( 1 ).max( 100 ).optional(),
			wikiUrl: z.string().url().describe( 'Optional URL of the wiki to use for this request.' ).optional()
		},
		{
			title: 'Search page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { query, limit, wikiUrl } ) => handleSearchPageTool( query, limit, wikiUrl )
	);
}

async function handleSearchPageTool( query: string, limit?: number, wikiUrl?: string ): Promise< CallToolResult > {
	const originalWikiKey = getCurrentWikiKey();
	try {
		if ( wikiUrl ) {
			const wikiKey = await resolveWiki( wikiUrl );
			setCurrentWiki( wikiKey );
		}
		const data = await makeRestGetRequest<MwRestApiSearchPageResponse>(
			'/v1/search/page',
			{ q: query, ...( limit ? { limit: limit.toString() } : {} ) }
		);

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
	} catch ( error ) {
		if ( error instanceof WikiDiscoveryError ) {
			return {
				content: [ { type: 'text', text: error.message } as TextContent ],
				isError: true
			};
		}
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve search data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	} finally {
		setCurrentWiki( originalWikiKey );
	}
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
