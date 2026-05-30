import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiMoveResponse } from 'mwn';
import type { ApiMoveParams } from 'types-mediawiki-api';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { getPageUrl, formatEditComment } from '../wikis/utils.js';

const inputSchema = {
	fromTitle: z.string().describe('Current title of the wiki page to move'),
	toTitle: z.string().describe('New title to move the page to'),
	comment: z.string().optional().describe('Reason for the move'),
	moveTalk: z.boolean().default(true).describe('Also move the associated talk page'),
	moveSubpages: z
		.boolean()
		.default(false)
		.describe('Also move subpages, where the namespace allows subpages'),
	leaveRedirect: z
		.boolean()
		.default(true)
		.describe(
			'Leave a redirect at the old title. Suppressing it requires the suppressredirect right; without that right MediaWiki leaves the redirect regardless.',
		),
	ignoreWarnings: z
		.boolean()
		.default(false)
		.describe(
			'Proceed past move warnings, e.g. when the target is an existing redirect. Moving over a non-redirect page still fails.',
		),
} as const;

export const movePage: Tool<typeof inputSchema> = {
	name: 'move-page',
	description:
		'Renames a wiki page, moving it — and by default its talk page — to a new title, and returns the old and new titles plus whether a redirect was left behind. By default leaves a redirect at the old title; set leaveRedirect=false to suppress it (requires the suppressredirect right, otherwise the redirect is left regardless). Fails if the source page does not exist, if the target title already exists (unless it is a redirect and ignoreWarnings is set), or if the authenticated user lacks the move permission. Moving a File page additionally requires the file-move permission.',
	inputSchema,
	annotations: {
		title: 'Move page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'move page',
	target: (a) => a.fromTitle,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const moveTalk = args.moveTalk ?? true;
		const moveSubpages = args.moveSubpages ?? false;
		const leaveRedirect = args.leaveRedirect ?? true;
		const ignoreWarnings = args.ignoreWarnings ?? false;

		const mwn = await ctx.mwn();
		// mwn.move hard-defaults movetalk:true internally before spreading
		// options, so we always pass movetalk explicitly to stay in control.
		const options = ctx.edit.applyTags<ApiMoveParams>({
			movetalk: moveTalk,
			movesubpages: moveSubpages,
			noredirect: !leaveRedirect,
			ignorewarnings: ignoreWarnings,
		});
		const data: ApiMoveResponse & {
			from?: string;
			to?: string;
			redirectcreated?: string;
			talkfrom?: string;
			talkto?: string;
			subpages?: unknown[];
		} = await mwn.move(
			args.fromTitle,
			args.toTitle,
			formatEditComment('move-page', args.comment),
			options,
		);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const to = data.to as string;
		return ctx.format.ok({
			from: data.from,
			to,
			redirectCreated: data.redirectcreated !== undefined,
			talkFrom: data.talkfrom,
			talkTo: data.talkto,
			subpagesMoved: Array.isArray(data.subpages) ? data.subpages.length : undefined,
			url: getPageUrl(to, ctx.activeWiki),
		});
	},
};
