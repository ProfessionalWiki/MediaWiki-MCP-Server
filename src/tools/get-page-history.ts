import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiPage, ApiRevision } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

const PAGE_HISTORY_LIMIT = 20;

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	olderThan: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Revision ID — return revisions older than this (exclusive). Mutually exclusive with newerThan.',
		),
	newerThan: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Revision ID — return revisions newer than this (exclusive). Mutually exclusive with olderThan.',
		),
	filter: z.string().optional().describe('Change tag — return only revisions carrying this tag'),
} as const;

export const getPageHistory: Tool<typeof inputSchema> = {
	name: 'get-page-history',
	description: `Returns revision metadata (revision ID, timestamp, user, comment, size, minor flag) for a wiki page, in segments of ${PAGE_HISTORY_LIMIT} revisions, newest first. Paginate with olderThan or newerThan (mutually exclusive). If the title does not exist, an error is returned.`,
	inputSchema,
	annotations: {
		title: 'Get page history',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve page history',
	target: (a) => a.title,

	async handle({ title, olderThan, newerThan, filter }, ctx: ToolContext): Promise<CallToolResult> {
		if (olderThan && newerThan) {
			return ctx.format.invalidInput('olderThan and newerThan are mutually exclusive');
		}

		const mwn = await ctx.mwn();
		const boundaryId = olderThan ?? newerThan;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			prop: 'revisions',
			titles: title,
			rvprop: 'ids|timestamp|user|userid|comment|size|flags|tags',
			// Fetch one extra when a boundary is set, since rvstartid is
			// inclusive and we filter the boundary out below.
			rvlimit: PAGE_HISTORY_LIMIT + (boundaryId ? 1 : 0),
			formatversion: '2',
		};

		// Both olderThan and newerThan use rvstartid (the enumeration anchor);
		// they differ only in direction. Default rvdir=older walks newest →
		// oldest, so olderThan needs no rvdir override.
		if (boundaryId) {
			params.rvstartid = boundaryId;
			if (newerThan) {
				params.rvdir = 'newer';
			}
		}

		if (filter) {
			params.rvtag = filter;
		}

		const response = await mwn.request(params);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const page = response.query?.pages?.[0] as ApiPage | undefined;

		if (page?.missing) {
			return ctx.format.notFound(`Page "${title}" not found`);
		}

		const revisions: ApiRevision[] = page?.revisions ?? [];

		// rvstartid is inclusive — filter out the boundary revision to
		// preserve the exclusive semantics of olderThan/newerThan, and cap
		// the result in case the boundary was absent from the window.
		const filteredRevisions = boundaryId
			? revisions.filter((rev) => rev.revid !== boundaryId).slice(0, PAGE_HISTORY_LIMIT)
			: revisions;

		let truncation: TruncationInfo | null = null;
		if (response.continue?.rvcontinue && filteredRevisions.length > 0) {
			const walkingForward = newerThan !== undefined;
			const anchorRev = filteredRevisions[filteredRevisions.length - 1].revid!;
			truncation = {
				reason: 'more-available',
				returnedCount: filteredRevisions.length,
				itemNoun: 'revisions',
				toolName: 'get-page-history',
				continueWith: {
					param: walkingForward ? 'newerThan' : 'olderThan',
					value: anchorRev,
				},
			};
		}

		return ctx.format.ok({
			revisions: filteredRevisions.map((r) => ({
				revisionId: r.revid!,
				timestamp: r.timestamp!,
				user: r.user,
				userid: r.userid,
				comment: r.comment,
				size: r.size,
				minor: r.minor ?? false,
				tags: (r as ApiRevision & { tags?: string[] }).tags,
			})),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
