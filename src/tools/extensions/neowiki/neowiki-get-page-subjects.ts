import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { presentSubject, type SubjectJson } from './subjects.ts';
import { pageIdOf, pageRefShape } from './pageId.ts';

const inputSchema = {
	...pageRefShape('the wiki page whose Subjects to list'),
} as const;

interface PageSubjectsResponse {
	pageId?: number;
	mainSubjectId?: string | null;
	subjects?: Record<string, SubjectJson>;
}

export const neowikiGetPageSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-get-page-subjects',
	description:
		"Lists the NeoWiki Subjects attached to a wiki page — each with full structured data — and identifies the page's Main Subject. Enabled only when the wiki has NeoWiki installed. This is the bridge from a wiki page (which you may already have from get-page) into its knowledge-graph data: one call returns every subject's statements, so you don't need to resolve subject IDs first. Dependent Subjects are listed with the hostSubject they belong to. Accepts a page title or a numeric page ID.",
	inputSchema,
	annotations: {
		title: 'Get NeoWiki page subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'get NeoWiki page subjects',
	target: (a) => a.title ?? (a.pageId !== undefined ? String(a.pageId) : ''),

	async handle({ title, pageId }, ctx: ToolContext): Promise<CallToolResult> {
		const resolvedPageId = await pageIdOf(ctx, { title, pageId });
		const mwn = await ctx.mwn();

		const data = await neowikiRequest<PageSubjectsResponse>(mwn, {
			method: 'GET',
			path: `/page/${resolvedPageId}/subjects`,
		});

		const mainSubjectId = data.mainSubjectId ?? null;
		const subjects = Object.entries(data.subjects ?? {}).map(([id, subject]) => ({
			...presentSubject(subject),
			isMain: id === mainSubjectId,
		}));

		return ctx.format.ok({
			pageId: data.pageId ?? resolvedPageId,
			mainSubjectId,
			subjects,
		});
	},
};
