import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';
import { attributedComment } from './editComment.ts';
import { resolvePageId, hasOnePageRef } from './pageId.ts';

// A statement keyed by property name. The write API reads `propertyType` (NOT
// the `type` key read tools return) and silently drops entries without it, so
// require it here — a malformed statement becomes an input error, not a no-op.
const statementSchema = z.object({
	propertyType: z
		.string()
		.min(1)
		.describe('Property type: text, url, date, datetime, select, number, boolean, or relation.'),
	value: z
		.unknown()
		.describe(
			'text/url/date/datetime → array of strings; select → array of option IDs (decode via neowiki-get-schema); number → number; boolean → boolean; relation → array of { target: subjectId, properties? }.',
		),
});

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
			"When true, create the page's Main Subject (at most one per page) instead of a child Subject. Defaults to false.",
		),
	label: z.string().min(1).describe('Display label for the new Subject.'),
	schema: z
		.string()
		.min(1)
		.describe(
			'Name of an existing Schema (entity type) the Subject instantiates. Discover names with neowiki-list-schemas.',
		),
	statements: z
		.record(z.string(), statementSchema)
		.describe(
			'Map of property name → { propertyType, value }. The key is propertyType, NOT the `type` read tools return. Validate first with neowiki-validate-subject.',
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

interface CreateResponse {
	status?: string;
	subjectId?: string;
	message?: string;
}

export const neowikiCreateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-create-subject',
	description:
		'Creates a new NeoWiki Subject on a wiki page and attaches its statements. Enabled only when the wiki has NeoWiki installed. Set isMain to make it the page\'s Main Subject (a page has at most one); otherwise it is added as a child Subject. Requires the edit right. Each statement is keyed by property name as { propertyType, value } — the key is propertyType, NOT the `type` key read tools return; a statement lacking propertyType is rejected. Value by type: text/url/date/datetime → array of strings (dates ISO, e.g. ["2020-12-31"]); select → array of option IDs (resolve labels via neowiki-get-schema); number → a number; boolean → a boolean; relation → array of { target: "<subjectId>", properties? }. Pre-validate with neowiki-validate-subject. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Create NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'create NeoWiki subject',
	target: (a) => a.label,

	async handle(
		{ title, pageId, isMain, label, schema, statements, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		if (!hasOnePageRef({ title, pageId })) {
			return ctx.format.invalidInput('Provide exactly one of title or pageId.');
		}

		const mwn = await ctx.mwn();
		try {
			const resolvedPageId = await resolvePageId(mwn, { title, pageId });
			if (resolvedPageId === null) {
				return ctx.format.notFound(`Page "${title}" not found`);
			}

			const segment = isMain === true ? 'mainSubject' : 'childSubjects';
			const editComment = attributedComment(ctx, 'neowiki-create-subject', comment);
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

			// Upstream returns HTTP 201 with { status: "error" } when a main subject
			// already exists (rather than a 4xx) — surface that as a conflict.
			if (data.status === 'error') {
				return ctx.format.conflict(data.message ?? 'Subject could not be created.');
			}

			return ctx.format.ok({
				subjectId: data.subjectId ?? '',
				status: data.status ?? 'created',
				pageId: resolvedPageId,
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
