import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { baseRevisionIdSchema, writeResult, type SubjectWriteResponse } from './subjects.ts';
import { dependentSubjectsSchema, statementsSchema } from './statements.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to replace (starts with s…). Resolve one with neowiki-search-subjects.'),
	baseRevisionId: baseRevisionIdSchema,
	label: z
		.string()
		.optional()
		.describe(
			'New display label. Omit it, or pass an empty string, to clear the label, as a Dependent Subject (one with hostSubject) requires.',
		),
	statements: statementsSchema.describe(
		'Full replacement statement map (property name → { propertyType, value }). Property names absent from this map are deleted; pass {} to clear all statements.',
	),
	dependentSubjects: dependentSubjectsSchema
		.optional()
		.describe(
			'Dependent Subjects to create or replace in the same revision, each the target of a relation in statements or in another item of this list.',
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

export const neowikiUpdateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-update-subject',
	description:
		"Replaces a NeoWiki Subject's label and statements — a FULL replace of the Subject as of baseRevisionId: an omitted or empty label is cleared, property names absent from `statements` are deleted, and {} clears all statements. Changes made after that revision to anything the write leaves as it was are kept beside the write; where both changed the same label or statement to different values, or one removed a Dependent Subject the other changed, the write is refused as an edit conflict and writes nothing, and neowiki-get-subject returns the Subject as it now is, with the revisionId to base a new write on. Returns the revision ID the page is at after the write as revisionId, the violations of its Schema the Subject was saved with, and the Subject as saved. Enabled only when the wiki has NeoWiki installed. The Subject's id, schema and page are immutable. Requires the edit right, and for a Controlled Subject, of a Schema with subjectsAreControlled in neowiki-get-schema, the neowiki-controlled-subject-edit right too. Read the current state and its revisionId with neowiki-get-subject first; to change one Statement and leave the rest as it is, use neowiki-set-statement or neowiki-remove-statement. Dependent Subjects are written through dependentSubjects as with neowiki-create-subject, and passing the ID of one this Subject reaches replaces it; dropping the last relation to a Dependent Subject deletes it. A write that breaks a rule for Dependent Subjects is refused; other violations are warnings unless the wiki enforces validation, which refuses a write that introduces an error-severity one. Pre-validate with neowiki-validate-subject. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Update NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'update NeoWiki subject',
	target: (a) => a.id,

	async handle(
		{ id, baseRevisionId, label, statements, dependentSubjects, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-update-subject', comment);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki replace response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'PUT',
			path: `/subject/${encodeURIComponent(id)}`,
			csrf: true,
			body: {
				label,
				statements,
				baseRevisionId,
				dependentSubjects,
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
