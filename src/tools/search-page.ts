import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiSearchResult } from 'mwn';
import { getPageUrl } from '../common/utils.js';
import { appendTruncationMarker, type TruncationInfo } from '../common/truncation.js';

export function searchPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'search-page',
		'Searches wiki page titles and page content (full-text) for the provided terms. Returns matching pages with a snippet, size, and timestamp. Accepts up to 100 matches per call (default 10); additional matches beyond the cap are flagged in the response — narrow the query to surface more. For title-prefix lookup (e.g. autocomplete), use search-page-by-prefix.',
		{
			query: z.string().describe( 'Search terms' ),
			limit: z.number().int().min( 1 ).max( 100 ).optional().describe( 'Maximum number of search results to return' )
		},
		{
			title: 'Search page',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( { query, limit } ) => handleSearchPageTool( query, limit )
	);
}

export async function handleSearchPageTool(
	query: string, limit?: number
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'search',
			srsearch: query,
			srwhat: 'text',
			srprop: 'snippet|size|timestamp',
			formatversion: '2'
		};

		if ( limit !== undefined ) {
			params.srlimit = limit;
		}

		const response = await mwn.request( params );
		const searchResults: ApiSearchResult[] = response.query?.search ?? [];

		if ( searchResults.length === 0 ) {
			return {
				content: [
					{ type: 'text', text: `No pages found for ${ query }` } as TextContent
				]
			};
		}

		const content: TextContent[] = searchResults.map( ( result ): TextContent => ( {
			type: 'text',
			text: [
				`Title: ${ result.title }`,
				`Page ID: ${ result.pageid }`,
				`Page URL: ${ getPageUrl( result.title ) }`,
				`Snippet: ${ result.snippet }`,
				`Size: ${ result.size }`,
				`Timestamp: ${ result.timestamp }`
			].join( '\n' )
		} ) );

		const truncation: TruncationInfo | null = response.continue ? {
			reason: 'capped-no-continuation',
			returnedCount: searchResults.length,
			limit: limit ?? 10,
			itemNoun: 'matches',
			narrowHint: 'narrow the query or raise limit (max 100)'
		} : null;

		return { content: appendTruncationMarker( content, truncation ) };
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve search data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
