import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiDeleteResponse } from 'mwn';
import type { ApiDeleteParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { instrumentToolCall } from './instrument.js';
import { formatEditComment } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function deletePageTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'delete-page',
		{
			description: 'Removes a wiki page from public view and returns the deleted title. This is a soft delete: the page and its revision history remain in the database and can be restored with undelete-page until an administrator purges them. Fails if the page does not exist or the authenticated user lacks the delete permission.',
			inputSchema: {
				title: z.string().describe( 'Wiki page title' ),
				comment: z.string().optional().describe( 'Reason for deleting the page' )
			},
			annotations: {
				title: 'Delete page',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		instrumentToolCall(
			'delete-page',
			async ( { title, comment } ) => handleDeletePageTool( title, comment ),
			( a ) => a.title
		)
	);
}

export async function handleDeletePageTool(
	title: string,
	comment?: string
): Promise<CallToolResult> {
	let data: ApiDeleteResponse & { logid?: number };
	try {
		const mwn = await getMwn();
		const { config } = wikiService.getCurrent();
		const options: ApiDeleteParams = {};
		if ( config.tags !== null && config.tags !== undefined ) {
			options.tags = config.tags;
		}
		data = await mwn.delete(
			title,
			formatEditComment( 'delete-page', comment ),
			options
		);
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to delete page: ${ ( error as Error ).message }`, code );
	}

	return structuredResult( {
		title: data.title as string,
		deleted: true as const,
		logId: data.logid
	} );
}
