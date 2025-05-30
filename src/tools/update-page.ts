import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPutRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Updates a wiki page. Replaces the existing content of a page with the provided content',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Page content in the same content model of the existing page' ),
			latestId: z.number().describe( 'Identifier for the revision used as the base for the new source' ),
			comment: z.string().describe( 'Summary of the edit' ).optional()
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async ( { title, source, latestId, comment } ) => handleUpdatePageTool( title, source, latestId, comment )
	);
}

async function handleUpdatePageTool( title: string, source: string, latestId: number, comment?: string ): Promise<CallToolResult> {
	const data = await makeRestPutRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }`, {
		source: source,
		comment: comment,
		latest: { id: latestId }
	}, true );

	if ( !data ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to update page' } as TextContent
			],
			isError: true
		};
	}

	return {
		content: updatePageToolResult( data )
	};
}

function updatePageToolResult( result: MwRestApiPageObject ): TextContent[] {
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
