import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiQueryAllPagesParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';

export function searchPageByPrefixTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'search-page-by-prefix',
		'Performs a prefix search for page titles.',
		{
			prefix: z.string().describe( 'Search prefix' ),
			limit: z.number().int().min( 1 ).max( 500 ).optional().describe( 'Maximum number of results to return' ),
			namespace: z.number().int().nonnegative().optional().describe( 'Namespace to search' )
		},
		{
			title: 'Search page by prefix',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async (
			{ prefix, limit, namespace }
		) => handleSearchPageByPrefixTool( prefix, limit, namespace )
	);
}

async function handleSearchPageByPrefixTool(
	prefix: string, limit?: number, namespace?: number
): Promise< CallToolResult > {
	let data: string[];
	try {
		const mwn = await getMwn();
		const options: ApiQueryAllPagesParams = {};

		if ( limit ) {
			options.aplimit = limit;
		}
		if ( namespace ) {
			options.apnamespace = namespace;
		}

		data = await mwn.getPagesByPrefix( prefix, options );
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve search data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	if ( data.length === 0 ) {
		return {
			content: [
				{ type: 'text', text: `No pages found with the prefix "${ prefix }"` } as TextContent
			]
		};
	}

	return {
		content: data.map( getSearchPageByPrefixToolResult )
	};
}

function getSearchPageByPrefixToolResult( title: string ): TextContent {
	return {
		type: 'text',
		text: title
	};
}
