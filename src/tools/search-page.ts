// TODO: Decide how to handle the tool's result
// TODO: Make tools into an interface

/* eslint-disable n/no-missing-import */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { z } from 'zod';
import { makeApiRequest } from '../common/utils.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResult } from '../types/mwRestApiSearch.js';

function formatSearchResult( result: MwRestApiSearchResult ): string {
	return [
		`Title: ${ result.title }`,
		`Description: ${ result.description ?? 'Not available' }`,
		`Thumbnail: ${ result.thumbnail?.url ?? 'Not available' }`
	].join( '\n' );
}

export function registerSearchPageTool( server: McpServer, apiBase: string ): void {
	server.tool(
		'search-page',
		'Search for a page on the wiki',
		{
			query: z.string().describe( 'The query to search for' )
		},
		async ( { query } ) => {
			const searchPath = '/rest.php/v1/search/page';
			const searchData = await makeApiRequest<MwRestApiSearchPageResponse>(
				apiBase,
				searchPath,
				{
					q: query,
					limit: '10' // Keep limit as a string if the API expects it
				}
			);

			if ( !searchData ) {
				return {
					content: [
						{
							type: 'text',
							text: 'Failed to retrieve search data'
						}
					]
				};
			}

			const pages = searchData.pages || [];
			if ( pages.length === 0 ) {
				return {
					content: [
						{
							type: 'text',
							text: `No pages found for ${ query }`
						}
					]
				};
			}

			const formattedPages = pages.map( formatSearchResult );
			const pagesText = `Pages found for ${ query }:\n\n${ formattedPages.join( '\n\n' ) }`; // Use double newline for better separation

			return {
				content: [
					{
						type: 'text',
						text: pagesText
					}
				]
			};
		}
	);
}
