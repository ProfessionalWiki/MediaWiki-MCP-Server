import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUndeleteResponse } from 'mwn';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { formatEditComment } from '../common/utils.js';

export function undeletePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'undelete-page',
		'Undeletes a wiki page.',
		{
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().describe( 'Reason for undeleting the page' ).optional()
		},
		{
			title: 'Undelete page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, comment }
		) => handleUndeletePageTool( title, comment )
	);
}

async function handleUndeletePageTool(
	title: string,
	comment?: string
): Promise<CallToolResult> {
	let data: ApiUndeleteResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.undelete( title, formatEditComment( 'undelete-page', comment ) );
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Undelete failed: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}

	return {
		content: undeletePageToolResult( data )
	};
}

function undeletePageToolResult( data: ApiUndeleteResponse ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page undeleted successfully: ${ data.title }`
		}
	];
}
