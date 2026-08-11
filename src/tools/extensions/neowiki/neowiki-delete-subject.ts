import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';
import { attributedComment } from './editComment.ts';

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
	},
	failureVerb: 'delete NeoWiki subject',
	target: (a) => a.id,

	async handle({ id, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const editComment = attributedComment(ctx, 'neowiki-delete-subject', comment);
		try {
			// The endpoint returns an empty 200 body on success; ignore it.
			await neowikiRequest(mwn, {
				method: 'DELETE',
				path: `/subject/${encodeURIComponent(id)}`,
				csrf: true,
				...(editComment !== undefined ? { body: { comment: editComment } } : {}),
			});

			return ctx.format.ok({ subjectId: id, status: 'deleted' });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
