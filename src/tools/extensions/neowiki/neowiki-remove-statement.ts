import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { baseRevisionIdSchema, writeResult, type SubjectWriteResponse } from './subjects.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID (starts with s…). Resolve one with neowiki-search-subjects.'),
	baseRevisionId: baseRevisionIdSchema,
	property: z
		.string()
		.min(1)
		.describe('Name of the property whose Statement to remove, as neowiki-get-subject names it.'),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

export const neowikiRemoveStatement: Tool<typeof inputSchema> = {
	name: 'neowiki-remove-statement',
	description:
		'Removes one Statement from a NeoWiki Subject, leaving its label and other Statements as they are. Returns the revision ID the page is at after the write as revisionId, the violations of its Schema the Subject was saved with, and the Subject as saved. Enabled only when the wiki has NeoWiki installed. Removing a Statement the Subject does not have changes nothing. Where the Statement, or a Dependent Subject it reaches, changed after baseRevisionId, the write is refused as an edit conflict and writes nothing, and neowiki-get-subject returns the Subject as it now is, with the revisionId to base a new write on. Removing a relation deletes the Dependent Subjects it reached. For a property whose name contains /, use neowiki-update-subject. Requires the edit right, and for a Controlled Subject, of a Schema with subjectsAreControlled in neowiki-get-schema, the neowiki-controlled-subject-edit right too. A write that breaks a rule for Dependent Subjects is refused; other violations are warnings unless the wiki enforces validation, which refuses a write that introduces an error-severity one.',
	inputSchema,
	annotations: {
		title: 'Remove NeoWiki statement',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'remove NeoWiki statement',
	target: (a) => a.id,

	async handle(
		{ id, baseRevisionId, property, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-remove-statement', comment);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki statement write response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'DELETE',
			path: `/subject/${encodeURIComponent(id)}/statements/${encodeURIComponent(property)}`,
			csrf: true,
			body: {
				baseRevisionId,
				...(editComment !== undefined ? { comment: editComment } : {}),
			},
		})) as SubjectWriteResponse;

		const subjectId = data.subjectId ?? id;
		return ctx.format.ok({
			subjectId,
			status: data.status ?? 'updated',
			...writeResult(data, subjectId),
		});
	},
};
