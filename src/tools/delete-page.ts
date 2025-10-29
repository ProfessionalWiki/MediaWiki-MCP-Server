import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiDeleteResponse } from 'mwn';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { formatEditComment } from '../common/utils.js';

export function deletePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'delete-page',
		'Deletes a wiki page.',
		{
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().describe( 'Reason for deleting the page' ).optional()
		},
		{
			title: 'Delete page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, comment }
		) => handleDeletePageTool( { title, comment } )
	);
}

async function handleDeletePageTool(
	params: { title: string; comment?: string }
): Promise<CallToolResult> {
	let data: ApiDeleteResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.delete( params.title, formatEditComment( 'delete-page', params.comment ) );
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Delete failed: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}

	return {
		content: deletePageToolResult( data )
	};
}

function deletePageToolResult( data: ApiDeleteResponse ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page deleted successfully: ${ data.title }`
		}
	];
}
