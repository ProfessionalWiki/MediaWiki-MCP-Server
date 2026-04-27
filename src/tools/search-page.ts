import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiSearchResult } from 'mwn';
import { instrumentToolCall } from './instrument.js';
import { getPageUrl } from '../common/utils.js';
import type { TruncationInfo } from '../common/truncation.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function searchPageTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'search-page',
		{
			description: 'Searches wiki page titles and page content (full-text) for the provided terms. Returns matching pages with a snippet, size, and timestamp. Accepts up to 100 matches per call (default 10); additional matches beyond the cap are flagged in the response — narrow the query to surface more. For title-prefix lookup (e.g. autocomplete), use search-page-by-prefix.',
			inputSchema: {
				query: z.string().describe( 'Search terms' ),
				limit: z.number().int().min( 1 ).max( 100 ).optional().describe( 'Maximum number of search results to return' )
			},
			annotations: {
				title: 'Search page',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		instrumentToolCall(
			'search-page',
			async ( { query, limit } ) => handleSearchPageTool( query, limit ),
			( a ) => a.query
		)
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
			srprop: 'snippet|size|timestamp|wordcount',
			formatversion: '2'
		};

		if ( limit !== undefined ) {
			params.srlimit = limit;
		}

		const response = await mwn.request( params );
		const searchResults: ApiSearchResult[] = response.query?.search ?? [];

		const truncation: TruncationInfo | null = response.continue ? {
			reason: 'capped-no-continuation',
			returnedCount: searchResults.length,
			limit: limit ?? 10,
			itemNoun: 'matches',
			narrowHint: 'narrow the query or raise limit (max 100)'
		} : null;

		return structuredResult( {
			results: searchResults.map( ( r ) => ( {
				title: r.title,
				pageId: r.pageid,
				snippet: r.snippet,
				size: r.size,
				wordCount: ( r as ApiSearchResult & { wordcount?: number } ).wordcount,
				timestamp: r.timestamp,
				url: getPageUrl( r.title )
			} ) ),
			...( truncation !== null ? { truncation } : {} )
		} );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve search data: ${ ( error as Error ).message }`, code );
	}
}
