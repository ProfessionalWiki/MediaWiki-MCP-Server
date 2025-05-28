import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Returns the standard page object for a wiki page, including the API route to fetch the latest content in HTML, the license, and information about the latest revision.',
		{
			title: z.string().describe( 'Wiki page title' )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title } ) => handleGetPageTool( title )
	);
}

async function handleGetPageTool( title: string ): Promise< CallToolResult > {
	const data = await makeRestGetRequest<MwRestApiPageObject>( `/v1/page/${ title }/bare` );

	if ( !data ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to retrieve page data' } as TextContent
			],
			isError: true
		};
	}

	return {
		content: getPageToolResult( data )
	};
}

function getPageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: [
				`Page ID: ${ result.id }`,
				`Title: ${ result.title }`,
				`Latest revision ID: ${ result.latest.id }`,
				`Latest revision timestamp: ${ result.latest.timestamp }`,
				`Content model: ${ result.content_model }`,
				`License: ${ result.license.url } ${ result.license.title }`,
				`HTML URL: ${ result.html_url }`
			].join( '\n' )
		}
	];
}
