import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiGetPageHistoryResponse, MwRestApiRevisionObject } from '../types/mwRestApi.js';

export function getPageHistoryTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page-history',
		'Returns information about the latest revisions to a wiki page, in segments of 20 revisions, starting with the latest revision. The response includes API routes for the next oldest, next newest, and latest revision segments.',
		{
			title: z.string().describe( 'Wiki page title' ),
			olderThan: z.number().describe( 'The ID of the oldest revision to return' ).optional(),
			newerThan: z.number().describe( 'The ID of the newest revision to return' ).optional(),
			filter: z.string().describe( 'Filter that returns only revisions with certain tags. Only support one filter per request.' ).optional()
		},
		{
			title: 'Get page history',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async (
			{ title, olderThan, newerThan, filter }
		) => handleGetPageHistoryTool( title, olderThan, newerThan, filter )
	);
}

async function handleGetPageHistoryTool(
	title: string,
	olderThan?: number,
	newerThan?: number,
	filter?: string
): Promise< CallToolResult > {
	const params: Record<string, string> = {};
	if ( olderThan ) {
		params.olderThan = olderThan.toString();
	}
	if ( newerThan ) {
		params.newerThan = newerThan.toString();
	}
	if ( filter ) {
		params.filter = filter;
	}

	let data: MwRestApiGetPageHistoryResponse | null = null;
	try {
		data = await makeRestGetRequest<MwRestApiGetPageHistoryResponse>(
			`/v1/page/${ encodeURIComponent( title ) }/history`,
			params
		);
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve page history: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	if ( data === null ) {
		return {
			content: [
				{
					type: 'text',
					text: 'Failed to retrieve page data: No data returned from API'
				} as TextContent
			],
			isError: true
		};
	}

	if ( data.revisions.length === 0 ) {
		return {
			content: [
				{ type: 'text', text: 'No revisions found for page' } as TextContent
			]
		};
	}

	return {
		content: data.revisions.map( getPageHistoryToolResult )
	};
}

function getPageHistoryToolResult( result: MwRestApiRevisionObject ): TextContent {
	return {
		type: 'text',
		text: [
			`Revision ID: ${ result.id }`,
			`Timestamp: ${ result.timestamp }`,
			`User: ${ result.user.name } (ID: ${ result.user.id })`,
			`Comment: ${ result.comment }`,
			`Size: ${ result.size }`,
			`Delta: ${ result.delta }`
		].join( '\n' )
	};
}
