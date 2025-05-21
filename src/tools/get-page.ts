// TODO: Make tools into an interface
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeApiRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { WIKI_SERVER, SCRIPT_PATH } from '../common/config.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Get a wiki page object for a wiki page',
		{
			title: z.string().describe( 'The title of the page to get' )
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
	const url = `${ WIKI_SERVER() }${ SCRIPT_PATH() }/rest.php/v1/page/${ title }/bare`;
	const data = await makeApiRequest<MwRestApiPageObject>(
		url, { title: title }
	);

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
