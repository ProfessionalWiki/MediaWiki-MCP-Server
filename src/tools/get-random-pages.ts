import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { RedirectFilter } from './get-links-here.ts';

interface RandomEntry {
	id: number;
	ns: number;
	title: string;
}

const inputSchema = {
	namespace: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe('Namespace ID to draw wiki pages from'),
	filter: z
		.nativeEnum(RedirectFilter)
		.default(RedirectFilter.nonredirects)
		.describe('Filter the drawn wiki pages by redirect status'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.default(10)
		.describe('Number of wiki pages to draw (1..500)'),
} as const;

export const getRandomPages: Tool<typeof inputSchema> = {
	name: 'get-random-pages',
	description:
		"Returns randomly chosen wiki pages from one namespace, as each page's title, page ID, and namespace ID, as Special:Random does for readers. Use when a task needs pages picked independently of edit recency or search ranking, such as spot-checking page quality across the wiki. Only the starting point is random: the wiki keeps its pages in one fixed shuffled order, and a call returns the run of pages that follows that point, so calls starting near each other overlap. For pages drawn independently of one another, make several calls with a small limit. There is no continuation; each call picks a new starting point. For page content, pass the titles to get-pages.",
	inputSchema,
	annotations: {
		title: 'Get random pages',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve random pages',

	async handle({ namespace, filter, limit }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		const response = await mwn.request({
			action: 'query',
			list: 'random',
			rnnamespace: namespace,
			rnfilterredir: filter,
			rnlimit: limit,
			formatversion: '2',
		});
		const pages: RandomEntry[] = response.query?.random ?? [];

		return ctx.format.ok({
			results: pages.map((p) => ({
				title: p.title,
				pageId: p.id,
				namespace: p.ns,
			})),
		});
	},
};
