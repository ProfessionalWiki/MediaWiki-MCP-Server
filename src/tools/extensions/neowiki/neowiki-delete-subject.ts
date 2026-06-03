import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to delete (starts with s…). Resolve one with neowiki-search-subjects.'),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

export const neowikiDeleteSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-delete-subject',
	description:
		'Deletes one NeoWiki Subject by ID from its page. Enabled only when the wiki has NeoWiki installed. Requires the edit right. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Delete NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'delete NeoWiki subject',
	target: (a) => a.id,

	async handle({ id, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// The endpoint returns an empty 200 body on success; ignore it.
			await neowikiRequest(mwn, {
				method: 'DELETE',
				path: `/subject/${encodeURIComponent(id)}`,
				csrf: true,
				...(comment !== undefined ? { body: { comment } } : {}),
			});

			return ctx.format.ok({ subjectId: id, status: 'deleted' });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
