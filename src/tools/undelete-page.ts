import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUndeleteResponse } from 'mwn';
import type { ApiUndeleteParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { formatEditComment } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function undeletePageTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'undelete-page',
		{
			description: 'Restores a previously deleted wiki page, including its full revision history, and returns the restored title. The page must currently be in a deleted state (from delete-page); fails if no deleted revisions exist for the title or the authenticated user lacks the undelete permission.',
			inputSchema: {
				title: z.string().describe( 'Wiki page title' ),
				comment: z.string().optional().describe( 'Reason for undeleting the page' )
			},
			annotations: {
				title: 'Undelete page',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ title, comment }
		) => handleUndeletePageTool( title, comment )
	);
}

export async function handleUndeletePageTool(
	title: string,
	comment?: string
): Promise<CallToolResult> {
	let data: ApiUndeleteResponse & { revisions?: number };
	try {
		const mwn = await getMwn();
		const { config } = wikiService.getCurrent();
		const options: ApiUndeleteParams = {};
		if ( config.tags !== null && config.tags !== undefined ) {
			options.tags = config.tags;
		}
		data = await mwn.undelete(
			title,
			formatEditComment( 'undelete-page', comment ),
			options
		);
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to undelete page: ${ ( error as Error ).message }`, code );
	}

	return structuredResult( {
		title: data.title as string,
		restored: true as const,
		revisionCount: data.revisions
	} );
}
