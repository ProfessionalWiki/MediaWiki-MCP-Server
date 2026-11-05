import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { botArgSchema } from '../runtime/botArg.ts';
import { formatEditComment, resolveBotFlag } from '../wikis/utils.ts';
import { submitPageEdit } from '../services/pageEdit.ts';

const inputSchema = {
	source: z.string().describe('Page content in the format specified by the contentModel parameter'),
	title: z.string().describe('Wiki page title'),
	comment: z.string().optional().describe('Reason for creating the page'),
	contentModel: z
		.string()
		.optional()
		.describe(
			"Content model of the new page. If omitted, MediaWiki picks the default for the title's namespace.",
		),
	bot: botArgSchema,
} as const;

export const createPage: Tool<typeof inputSchema> = {
	name: 'create-page',
	description:
		"Creates a new wiki page with the provided content and returns the new page's title, page ID, and first revision ID. Fails if a page with the given title already exists; for existing pages, use update-page. The optional contentModel parameter selects a non-default content format (e.g. javascript, css); when omitted, MediaWiki picks the default for the title's namespace. For building up a large page across multiple calls, pair create-page with chained update-page(operation='append') calls, each adding a chunk.",
	inputSchema,
	annotations: {
		title: 'Create page',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'create page',
	target: (a) => a.title,

	async handle(
		{ source, title, comment, contentModel, bot },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// Not mwn.create(), which marks every edit as a bot edit unless told otherwise.
		const params = {
			action: 'edit',
			title,
			text: source,
			summary: formatEditComment(ctx, 'create-page', comment),
			createonly: true,
			...(contentModel !== undefined ? { contentmodel: contentModel } : {}),
			...(resolveBotFlag(ctx, bot) ? { bot: true } : {}),
		};
		return submitPageEdit(ctx, mwn, 'create page', params, { title });
	},
};
