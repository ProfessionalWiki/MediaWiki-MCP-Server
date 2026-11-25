import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { pageIdOf, pageRefShape } from './pageId.ts';

const inputSchema = {
	...pageRefShape('the wiki page whose Main Subject to set'),
	subjectId: z
		.string()
		.min(1)
		.nullable()
		.describe(
			'Subject ID (starts with s…) on this page to promote to Main Subject, or null to clear the Main Subject.',
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

interface SetMainResponse {
	status: string;
}

export const neowikiSetMainSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-set-main-subject',
	description:
		"Sets which existing Subject on a wiki page is its Main Subject, or clears it. Enabled only when the wiki has NeoWiki installed. Pass subjectId to promote one of the page's other Subjects, or null to clear the Main Subject. A Dependent Subject cannot be a Main Subject. This differs from neowiki-create-subject with isMain, which creates a NEW main Subject. Requires the edit right.",
	inputSchema,
	annotations: {
		title: 'Set NeoWiki main subject',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'set NeoWiki main subject',
	target: (a) => a.subjectId ?? '',

	async handle({ title, pageId, subjectId, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const resolvedPageId = await pageIdOf(ctx, { title, pageId });
		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-set-main-subject', comment);

		// Always send the subjectId key: omitting it is a 400 upstream, whereas
		// an explicit null is the documented way to clear the Main Subject.
		const data = await neowikiRequest<SetMainResponse>(mwn, {
			method: 'PUT',
			path: `/page/${resolvedPageId}/mainSubject`,
			csrf: true,
			body: { subjectId, comment: editComment },
		});

		return ctx.format.ok({ pageId: resolvedPageId, status: data.status });
	},
};
