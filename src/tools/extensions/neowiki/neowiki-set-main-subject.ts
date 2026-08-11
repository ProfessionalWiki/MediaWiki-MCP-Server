import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';
import { attributedComment } from './editComment.ts';
import { resolvePageId, hasOnePageRef } from './pageId.ts';

const inputSchema = {
	title: z.string().min(1).optional().describe('Wiki page title. Provide this OR pageId.'),
	pageId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Numeric MediaWiki page ID. Provide this OR title.'),
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
	status?: string;
}

export const neowikiSetMainSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-set-main-subject',
	description:
		'Sets which existing Subject on a wiki page is its Main Subject, or clears it. Enabled only when the wiki has NeoWiki installed. Pass subjectId to promote a Subject that already exists on the page, or null to clear the Main Subject. This differs from neowiki-create-subject with isMain, which creates a NEW main Subject. Requires the edit right. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Set NeoWiki main subject',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'set NeoWiki main subject',
	target: (a) => a.subjectId ?? '',

	async handle({ title, pageId, subjectId, comment }, ctx: ToolContext): Promise<CallToolResult> {
		if (!hasOnePageRef({ title, pageId })) {
			return ctx.format.invalidInput('Provide exactly one of title or pageId.');
		}

		const mwn = await ctx.mwn();
		try {
			const resolvedPageId = await resolvePageId(mwn, { title, pageId });
			if (resolvedPageId === null) {
				return ctx.format.notFound(`Page "${title}" not found`);
			}

			const editComment = attributedComment(ctx, 'neowiki-set-main-subject', comment);
			// Always send the subjectId key: omitting it is a 400 upstream, whereas
			// an explicit null is the documented way to clear the Main Subject.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki set-main response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'PUT',
				path: `/page/${resolvedPageId}/mainSubject`,
				csrf: true,
				body: { subjectId, ...(editComment !== undefined ? { comment: editComment } : {}) },
			})) as SetMainResponse;

			return ctx.format.ok({ pageId: resolvedPageId, status: data.status ?? 'changed' });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
