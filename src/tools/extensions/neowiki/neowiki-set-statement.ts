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
import { VALUE_FORMATS } from './statements.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID (starts with s…). Resolve one with neowiki-search-subjects.'),
	baseRevisionId: baseRevisionIdSchema,
	property: z
		.string()
		.min(1)
		.describe('Name of the property whose Statement to set, as neowiki-get-schema names it.'),
	value: z
		.unknown()
		.describe(`The Statement's value, shaped by the property's type: ${VALUE_FORMATS}.`),
	propertyType: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The property's type. Omit it to take the type the Subject's Schema gives the property; a property the Schema does not define needs one.",
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

export const neowikiSetStatement: Tool<typeof inputSchema> = {
	name: 'neowiki-set-statement',
	description: `Sets one Statement of a NeoWiki Subject, leaving its label and other Statements as they are; for a new label or several Statements at once, use neowiki-update-subject. ${WRITE_RESULT} Enabled only when the wiki has NeoWiki installed. ${STATEMENT_EDIT_CONFLICT} A value that is empty for its type removes the Statement, as neowiki-remove-statement does. A Dependent Subject the old relation value targeted and the new one does not is deleted, and adding one takes neowiki-update-subject. For a property whose name contains /, use neowiki-update-subject. ${CONTROLLED_SUBJECT_RIGHTS} ${WRITE_VALIDATION}`,
	inputSchema,
	annotations: {
		title: 'Set NeoWiki statement',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'set NeoWiki statement',
	target: (a) => a.id,

	async handle(
		{ id, baseRevisionId, property, value, propertyType, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-set-statement', comment);
		const data = await neowikiRequest<SubjectWriteResponse>(mwn, {
			method: 'PUT',
			path: `/subject/${encodeURIComponent(id)}/statements/${encodeURIComponent(property)}`,
			csrf: true,
			body: {
				statement: { propertyType, value },
				baseRevisionId,
				comment: editComment,
			},
		});

		return ctx.format.ok(writeResult(data));
	},
};
