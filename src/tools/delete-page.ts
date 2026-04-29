import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiDeleteResponse } from 'mwn';
import type { ApiDeleteParams } from 'types-mediawiki-api';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { formatEditComment } from '../wikis/utils.js';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	comment: z.string().optional().describe('Reason for deleting the page'),
} as const;

export const deletePage: Tool<typeof inputSchema> = {
	name: 'delete-page',
	description:
		'Removes a wiki page from public view and returns the deleted title. This is a soft delete: the page and its revision history remain in the database and can be restored with undelete-page until an administrator purges them. Fails if the page does not exist or the authenticated user lacks the delete permission.',
	inputSchema,
	annotations: {
		title: 'Delete page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'delete page',
	target: (a) => a.title,

	async handle({ title, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const options = ctx.edit.applyTags<ApiDeleteParams>({});
		const data: ApiDeleteResponse & { logid?: number } = await mwn.delete(
			title,
			formatEditComment('delete-page', comment),
			options,
		);
		return ctx.format.ok({
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			title: data.title as string,
			deleted: true as const,
			logId: data.logid,
		});
	},
};
