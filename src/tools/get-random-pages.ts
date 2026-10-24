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
		"Returns a random sample of wiki pages from one namespace, as each page's title, page ID, and namespace ID, as Special:Random does for readers. Use when a task needs pages sampled without bias toward recent edits or search ranking, such as spot-checking page quality across the wiki. Each call draws a fresh sample; there is no continuation, and separate calls can return the same page. For page content, pass the titles to get-pages.",
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
