import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { resolvePageId, hasOnePageRef } from './pageId.ts';
import { flattenSubject, type SubjectData } from './neowiki-get-subject.ts';
import { statementsSchema, VALUE_FORMATS } from './statements.ts';

const inputSchema = {
	title: z
		.string()
		.min(1)
		.optional()
		.describe('Wiki page title to attach the Subject to. Provide this OR pageId.'),
	pageId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Numeric MediaWiki page ID. Provide this OR title.'),
	isMain: z
		.boolean()
		.optional()
		.describe(
			"When true, create the page's Main Subject (at most one per page) instead of one of its other Subjects. Defaults to false.",
		),
	label: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Display label for the new Subject. Omit for a Subject without one: a Main Subject is then shown under its page title, any other Subject under its Schema name.',
		),
	schema: z
		.string()
		.min(1)
		.describe(
			'Name of an existing Schema (entity type) the Subject instantiates. Discover names with neowiki-list-schemas.',
		),
	statements: statementsSchema.describe(
		'Map of property name → { propertyType, value }. The key is propertyType, NOT the `type` read tools return. Validate first with neowiki-validate-subject.',
	),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

interface CreateResponse {
	status?: string;
	subjectId?: string;
	violations?: unknown[];
	subject?: SubjectData;
}

export const neowikiCreateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-create-subject',
	description: `Creates a new NeoWiki Subject on an existing wiki page and returns its ID, the violations of its Schema it was saved with, and the Subject as saved. Enabled only when the wiki has NeoWiki installed. Set isMain to make it the page's Main Subject (a page has at most one); otherwise it joins the page's other Subjects. Requires the edit right. Each statement is keyed by property name as { propertyType, value } — the key is propertyType, NOT the \`type\` key read tools return; a statement lacking propertyType is rejected, and one whose value is empty is dropped. Value by type: ${VALUE_FORMATS}. Violations are warnings unless the wiki enforces validation, which refuses a write that introduces an error-severity violation. A Subject of a Schema whose Subjects are dependent (subjectsAreDependent in neowiki-get-schema) cannot be created with this tool. Pre-validate with neowiki-validate-subject. Pre-1.0: the NeoWiki API may change without notice.`,
	inputSchema,
	annotations: {
		title: 'Create NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'create NeoWiki subject',
	target: (a) => a.label ?? a.schema,

	async handle(
		{ title, pageId, isMain, label, schema, statements, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		if (!hasOnePageRef({ title, pageId })) {
			return ctx.format.invalidInput('Provide exactly one of title or pageId.');
		}

		const mwn = await ctx.mwn();
		const editComment = formatEditComment(ctx, 'neowiki-create-subject', comment);
		try {
			const resolvedPageId = await resolvePageId(mwn, { title, pageId });
			if (resolvedPageId === null) {
				return ctx.format.notFound(`Page "${title}" not found`);
			}

			const segment = isMain === true ? 'mainSubject' : 'subjects';
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki create response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'POST',
				path: `/page/${resolvedPageId}/${segment}`,
				csrf: true,
				body: {
					label,
					schema,
					statements,
					...(editComment !== undefined ? { comment: editComment } : {}),
				},
			})) as CreateResponse;

			const subjectId = data.subjectId ?? '';
			return ctx.format.ok({
				subjectId,
				status: data.status ?? 'created',
				pageId: resolvedPageId,
				violations: Array.isArray(data.violations) ? data.violations : [],
				...(data.subject !== undefined ? { subject: flattenSubject(data.subject, subjectId) } : {}),
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
