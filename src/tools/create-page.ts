import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiEditPageParams } from 'types-mediawiki-api';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { buildPageUrl, formatEditComment } from '../wikis/utils.js';

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
	bot: z
		.boolean()
		.optional()
		.describe(
			'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.',
		),
} as const;

export const createPage: Tool<typeof inputSchema> = {
	name: 'create-page',
	description:
		"Creates a new wiki page with the provided content and returns the new page's title, page ID, and first revision ID. Fails if a page with the given title already exists; for existing pages, use update-page. The optional contentModel parameter selects a non-default content format (e.g. javascript, css); when omitted, MediaWiki picks the default for the title's namespace. For building up a large page across multiple calls, pair create-page with chained update-page(mode='append') calls, each adding a chunk.",
	inputSchema,
	annotations: {
		title: 'Create page',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'create page',
	target: (a) => a.title,

	async handle(
		{ source, title, comment, contentModel, bot },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const baseOptions: ApiEditPageParams = {};
		if (contentModel !== undefined) {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- input is validated against ApiEditPageParams.contentmodel via the inputSchema enum
			baseOptions.contentmodel = contentModel as ApiEditPageParams['contentmodel'];
		}
		if (bot === true) {
			baseOptions.bot = true;
		}
		const options = ctx.edit.applyTags<ApiEditPageParams>(baseOptions);
		const result = await mwn.create(
			title,
			source,
			formatEditComment('create-page', comment),
			options,
		);

		return ctx.format.ok({
			pageId: result.pageid,
			title: result.title,
			latestRevisionId: result.newrevid,
			latestRevisionTimestamp: result.newtimestamp,
			contentModel: result.contentmodel,
			...(bot === true ? { botMarked: await ctx.edit.botRight(mwn) } : {}),
			url: await buildPageUrl(ctx, result.title),
		});
	},
};
