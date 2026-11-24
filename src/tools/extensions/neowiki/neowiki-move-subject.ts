import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { resolvePageId, hasOnePageRef } from './pageId.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to move (starts with s…). Resolve one with neowiki-search-subjects.'),
	title: z
		.string()
		.min(1)
		.optional()
		.describe('Title of the wiki page to move the Subject to. Provide this OR pageId.'),
	pageId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Numeric MediaWiki page ID of the page to move the Subject to. Provide this OR title.',
		),
	isMain: z
		.boolean()
		.optional()
		.describe(
			"When true, make the Subject the target page's Main Subject; the page's current Main Subject becomes one of its other Subjects. Defaults to false.",
		),
	comment: z.string().optional().describe('Optional edit summary, for the edits to both pages.'),
} as const;

interface MoveSubjectResponse {
	status?: string;
}

export const neowikiMoveSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-move-subject',
	description:
		"Moves a NeoWiki Subject to another existing wiki page, keeping its ID, so relations that target it keep resolving; its Dependent Subjects move with it. Returns status `changed`, or `unchanged` when the Subject is already on that page, and the ID of the page it is on. Enabled only when the wiki has NeoWiki installed. Set isMain to make it the target page's Main Subject; to change the Main Subject among a page's own Subjects, use neowiki-set-main-subject. A Dependent Subject moves only with its Host Subject: moving one alone is refused. Edits both pages, so it requires the edit right on each, and for a Controlled Subject, of a Schema with subjectsAreControlled in neowiki-get-schema, the neowiki-controlled-subject-edit right too. Returns no revision ID: read the Subject with neowiki-get-subject for the baseRevisionId of a later write.",
	inputSchema,
	annotations: {
		title: 'Move NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'move NeoWiki subject',
	target: (a) => a.id,

	async handle({ id, title, pageId, isMain, comment }, ctx: ToolContext): Promise<CallToolResult> {
		if (!hasOnePageRef({ title, pageId })) {
			return ctx.format.invalidInput('Provide exactly one of title or pageId.');
		}

		const mwn = await ctx.mwn();
		const targetPageId = await resolvePageId(mwn, { title, pageId });
		if (targetPageId === null) {
			return ctx.format.notFound(`Page "${title}" not found`);
		}

		const editComment = formatEditComment(ctx, 'neowiki-move-subject', comment);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki move response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'POST',
			path: `/subject/${encodeURIComponent(id)}/move`,
			csrf: true,
			body: {
				targetPageId,
				...(isMain === true ? { makeMainSubject: true } : {}),
				...(editComment !== undefined ? { comment: editComment } : {}),
			},
		})) as MoveSubjectResponse;

		return ctx.format.ok({
			subjectId: id,
			status: data.status ?? 'changed',
			pageId: targetPageId,
		});
	},
};
