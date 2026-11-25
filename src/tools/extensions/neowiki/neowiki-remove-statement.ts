import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import {
	baseRevisionIdSchema,
	writeResult,
	type SubjectWriteResponse,
	CONTROLLED_SUBJECT_RIGHTS,
	WRITE_VALIDATION,
	STATEMENT_EDIT_CONFLICT,
	WRITE_RESULT,
} from './subjects.ts';

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
	description: `Removes one Statement from a NeoWiki Subject, leaving its label and other Statements as they are. ${WRITE_RESULT} Enabled only when the wiki has NeoWiki installed. Removing a Statement the Subject does not have changes nothing. ${STATEMENT_EDIT_CONFLICT} Removing a relation deletes the Dependent Subjects it reached. For a property whose name contains /, use neowiki-update-subject. ${CONTROLLED_SUBJECT_RIGHTS} ${WRITE_VALIDATION}`,
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
		const data = await neowikiRequest<SubjectWriteResponse>(mwn, {
			method: 'DELETE',
			path: `/subject/${encodeURIComponent(id)}/statements/${encodeURIComponent(property)}`,
			csrf: true,
			body: {
				baseRevisionId,
				comment: editComment,
			},
		});

		return ctx.format.ok(writeResult(data));
	},
};
