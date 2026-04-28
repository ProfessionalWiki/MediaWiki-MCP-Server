import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

interface AllPagesEntry {
	pageid: number;
	ns: number;
	title: string;
}

const inputSchema = {
	prefix: z.string().describe( 'Wiki page title prefix' ),
	limit: z.number().int().min( 1 ).max( 500 ).optional().describe( 'Maximum number of results to return' ),
	namespace: z.number().int().nonnegative().optional().describe( 'Namespace ID to restrict the search to' )
} as const;

export const searchPageByPrefix: Tool<typeof inputSchema> = {
	name: 'search-page-by-prefix',
	description: 'Returns wiki page titles beginning with a given prefix (suited to autocomplete and title lookup). Only titles are returned — no snippets, sizes, or IDs. Accepts up to 500 titles per call (default 10); additional matches beyond the cap are flagged in the response. For full-text content search, use search-page.',
	inputSchema,
	annotations: {
		title: 'Search page by prefix',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'retrieve search data',
	target: ( a ) => a.prefix,

	async handle( { prefix, limit, namespace }, ctx: ToolContext ): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'allpages',
			apprefix: prefix,
			formatversion: '2'
		};
		if ( limit !== undefined ) {
			params.aplimit = limit;
		}
		if ( namespace !== undefined ) {
			params.apnamespace = namespace;
		}

		const response = await mwn.request( params );
		const pages: AllPagesEntry[] = response.query?.allpages ?? [];

		const truncation: TruncationInfo | null = response.continue ? {
			reason: 'capped-no-continuation',
			returnedCount: pages.length,
			limit: limit ?? 10,
			itemNoun: 'titles',
			narrowHint: 'narrow the prefix or raise limit (max 500)'
		} : null;

		return ctx.format.ok( {
			results: pages.map( ( p ) => ( {
				title: p.title,
				pageId: p.pageid,
				namespace: p.ns
			} ) ),
			...( truncation !== null ? { truncation } : {} )
		} );
	}
};
