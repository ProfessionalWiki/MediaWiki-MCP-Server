import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { TruncationInfo } from '../common/truncation.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

interface AllPagesEntry {
	pageid: number;
	ns: number;
	title: string;
}

export function searchPageByPrefixTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'search-page-by-prefix',
		{
			description: 'Returns wiki page titles beginning with a given prefix (suited to autocomplete and title lookup). Only titles are returned — no snippets, sizes, or IDs. Accepts up to 500 titles per call (default 10); additional matches beyond the cap are flagged in the response. For full-text content search, use search-page.',
			inputSchema: {
				prefix: z.string().describe( 'Wiki page title prefix' ),
				limit: z.number().int().min( 1 ).max( 500 ).optional().describe( 'Maximum number of results to return' ),
				namespace: z.number().int().nonnegative().optional().describe( 'Namespace ID to restrict the search to' )
			},
			annotations: {
				title: 'Search page by prefix',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ prefix, limit, namespace }
		) => handleSearchPageByPrefixTool( prefix, limit, namespace )
	);
}

export async function handleSearchPageByPrefixTool(
	prefix: string, limit?: number, namespace?: number
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();

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

		return structuredResult( {
			results: pages.map( ( p ) => ( {
				title: p.title,
				pageId: p.pageid,
				namespace: p.ns
			} ) ),
			...( truncation !== null ? { truncation } : {} )
		} );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve search data: ${ ( error as Error ).message }`, code );
	}
}
