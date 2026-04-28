import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiSearchResult } from 'mwn';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { getPageUrl } from '../wikis/utils.js';
import type { TruncationInfo } from '../results/truncation.js';

const inputSchema = {
	query: z.string().describe( 'Search terms' ),
	limit: z.number().int().min( 1 ).max( 100 ).optional().describe( 'Maximum number of search results to return' )
} as const;

export const searchPage: Tool<typeof inputSchema> = {
	name: 'search-page',
	description: 'Searches wiki page titles and page content (full-text) for the provided terms. Returns matching pages with a snippet, size, and timestamp. Accepts up to 100 matches per call (default 10); additional matches beyond the cap are flagged in the response — narrow the query to surface more. For title-prefix lookup (e.g. autocomplete), use search-page-by-prefix.',
	inputSchema,
	annotations: {
		title: 'Search page',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,

	async handle( { query, limit }, ctx: ToolContext ): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

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

		return ctx.format.ok( {
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
	}
};
