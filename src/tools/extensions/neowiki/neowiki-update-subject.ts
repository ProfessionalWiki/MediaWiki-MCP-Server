import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { flattenSubject, type SubjectData } from './neowiki-get-subject.ts';
import { statementsSchema, VALUE_FORMATS } from './statements.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to replace (starts with s…). Resolve one with neowiki-search-subjects.'),
	label: z
		.string()
		.min(1)
		.optional()
		.describe(
			'New display label. Omit to clear the label, as a Dependent Subject (one with hostSubject) requires.',
		),
	statements: statementsSchema.describe(
		'Full replacement statement map (property name → { propertyType, value }). Property names absent from this map are deleted; pass {} to clear all statements. The key is propertyType, NOT the `type` read tools return.',
	),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

interface UpdateResponse {
	status?: string;
	subjectId?: string;
	violations?: unknown[];
	subject?: SubjectData;
}

export const neowikiUpdateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-update-subject',
	description: `Replaces a NeoWiki Subject's label and statements — a FULL replace: an omitted label is cleared, property names absent from \`statements\` are deleted, and {} clears all statements. Returns the violations of its Schema the Subject was saved with, and the Subject as saved. Enabled only when the wiki has NeoWiki installed. The Subject's id, schema and page are immutable. Requires the edit right. Read the current state with neowiki-get-subject first. Dropping the last relation to a Dependent Subject deletes that Dependent Subject. Each statement is keyed by property name as { propertyType, value } — the key is propertyType, NOT the \`type\` key read tools return. Value by type: ${VALUE_FORMATS}. Violations are warnings unless the wiki enforces validation, which refuses a write that introduces an error-severity violation. Pre-validate with neowiki-validate-subject. Pre-1.0: the NeoWiki API may change without notice.`,
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

	async handle({ id, label, statements, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-update-subject', comment);
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki replace response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'PUT',
				path: `/subject/${encodeURIComponent(id)}`,
				csrf: true,
				body: { label, statements, ...(editComment !== undefined ? { comment: editComment } : {}) },
			})) as UpdateResponse;

			const subjectId = data.subjectId ?? id;
			return ctx.format.ok({
				subjectId,
				status: data.status ?? 'updated',
				violations: Array.isArray(data.violations) ? data.violations : [],
				...(data.subject !== undefined ? { subject: flattenSubject(data.subject, subjectId) } : {}),
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
