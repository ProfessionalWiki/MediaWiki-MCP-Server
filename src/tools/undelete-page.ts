import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUndeleteResponse } from 'mwn';
import type { ApiUndeleteParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { formatEditComment } from '../wikis/utils.js';

const inputSchema = {
	title: z.string().describe( 'Wiki page title' ),
	comment: z.string().optional().describe( 'Reason for undeleting the page' )
} as const;

export const undeletePage: Tool<typeof inputSchema> = {
	name: 'undelete-page',
	description: 'Restores a previously deleted wiki page, including its full revision history, and returns the restored title. The page must currently be in a deleted state (from delete-page); fails if no deleted revisions exist for the title or the authenticated user lacks the undelete permission.',
	inputSchema,
	annotations: {
		title: 'Undelete page',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'undelete page',

	async handle( { title, comment }, ctx: ToolContext ): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const options = ctx.edit.applyTags<ApiUndeleteParams>( {} );
		const data: ApiUndeleteResponse & { revisions?: number } = await mwn.undelete(
			title,
			formatEditComment( 'undelete-page', comment ),
			options
		);

		return ctx.format.ok( {
			title: data.title as string,
			restored: true as const,
			revisionCount: data.revisions
		} );
	}
};
