import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';
import { flattenSubject } from './neowiki-get-subject.js';
import { resolvePageId, hasOnePageRef } from './pageId.js';

const inputSchema = {
	title: z
		.string()
		.min(1)
		.optional()
		.describe('Wiki page title. Provide this OR pageId, not both.'),
	pageId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Numeric MediaWiki page ID. Provide this OR title, not both.'),
} as const;

interface SubjectData {
	id?: string;
	label?: string;
	schema?: string;
	statements?: Record<string, { type?: string; value?: unknown }>;
}

interface PageSubjectsResponse {
	pageId?: number;
	mainSubjectId?: string | null;
	subjects?: Record<string, SubjectData>;
}

export const neowikiGetPageSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-get-page-subjects',
	description:
		"Lists the NeoWiki Subjects attached to a wiki page — each with full structured data — and identifies the page's Main Subject. Enabled only when the wiki has NeoWiki installed. This is the bridge from a wiki page (which you may already have from get-page) into its knowledge-graph data: one call returns every subject's statements, so you don't need to resolve subject IDs first. Accepts a page title or a numeric page ID. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Get NeoWiki page subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'get NeoWiki page subjects',
	target: (a) => a.title ?? (a.pageId !== undefined ? String(a.pageId) : ''),

	async handle({ title, pageId }, ctx: ToolContext): Promise<CallToolResult> {
		if (!hasOnePageRef({ title, pageId })) {
			return ctx.format.invalidInput('Provide exactly one of title or pageId.');
		}

		const mwn = await ctx.mwn();
		try {
			const resolvedPageId = await resolvePageId(mwn, { title, pageId });
			if (resolvedPageId === null) {
				return ctx.format.notFound(`Page "${title}" not found`);
			}

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /page/{id}/subjects response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: `/page/${resolvedPageId}/subjects`,
			})) as PageSubjectsResponse;

			const mainSubjectId = data.mainSubjectId ?? null;
			const subjects = Object.entries(data.subjects ?? {}).map(([id, subject]) => ({
				...flattenSubject(subject, id),
				isMain: id === mainSubjectId,
			}));

			return ctx.format.ok({
				pageId: data.pageId ?? resolvedPageId,
				mainSubjectId,
				subjects,
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
