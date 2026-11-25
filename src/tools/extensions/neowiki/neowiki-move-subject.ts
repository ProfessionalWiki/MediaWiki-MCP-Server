import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { pageIdOf, pageRefShape } from './pageId.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to move (starts with s…). Resolve one with neowiki-search-subjects.'),
	...pageRefShape('the wiki page to move the Subject to'),
	isMain: z
		.boolean()
		.optional()
		.describe(
			"When true, make the Subject the target page's Main Subject; the page's current Main Subject becomes one of its other Subjects. Defaults to false.",
		),
	comment: z.string().optional().describe('Optional edit summary, for the edits to both pages.'),
} as const;

interface MoveSubjectResponse {
	status: string;
}

export const neowikiMoveSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-move-subject',
	description:
		"Moves a NeoWiki Subject to another existing wiki page, keeping its ID, so relations that target it keep resolving; its Dependent Subjects move with it. Returns status `changed`, or `unchanged` when the Subject is already on that page, and the ID of the page it is on. Enabled only when the wiki has NeoWiki installed. Set isMain to make it the target page's Main Subject; to change the Main Subject among a page's own Subjects, use neowiki-set-main-subject. A Dependent Subject moves only with its Host Subject: moving one alone is refused. Edits both pages, so it requires the edit right on each, and for a Controlled Subject, of a Schema with subjectsAreControlled in neowiki-get-schema, the neowiki-controlled-subject-edit right too. Returns no revision ID: read the Subject with neowiki-get-subject for the baseRevisionId of a later write.",
	inputSchema,
	annotations: {
		title: 'Move NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'move NeoWiki subject',
	target: (a) => a.id,

	async handle({ id, title, pageId, isMain, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const targetPageId = await pageIdOf(ctx, { title, pageId });
		const mwn = await ctx.mwn();

		const editComment = formatEditComment(ctx, 'neowiki-move-subject', comment);
		const data = await neowikiRequest<MoveSubjectResponse>(mwn, {
			method: 'POST',
			path: `/subject/${encodeURIComponent(id)}/move`,
			csrf: true,
			body: {
				targetPageId,
				...(isMain === true ? { makeMainSubject: true } : {}),
				comment: editComment,
			},
		});

		return ctx.format.ok({
			subjectId: id,
			status: data.status,
			pageId: targetPageId,
		});
	},
};
