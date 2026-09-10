import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ApiRevision } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.ts';

// What helps depends on which revision was asked for. A revision ID taken from
// get-page metadata or from an edit that just landed is the current one, and
// section= is a narrower read of exactly those bytes. Only a genuinely past
// revision has nowhere narrower to go, because section= addresses the page as
// it stands rather than as it stood.
const CURRENT_REVISION_REMEDY =
	"This is the page's current revision, so to read part of it call get-page with section=N.";
const PAST_REVISION_REMEDY =
	'No narrower read of a past revision is available. To see what changed between revisions, use compare-pages.';

// Rendering HTML alone makes no revisions query, so which revision this is can
// be unknown; the remedy then names both routes rather than asserting either.
const UNKNOWN_REVISION_REMEDY =
	"If this is the page's current revision, call get-page with section=N to read part of it; otherwise use compare-pages.";

function remedyFor(isCurrent: boolean | undefined): string {
	if (isCurrent === undefined) {
		return UNKNOWN_REVISION_REMEDY;
	}
	return isCurrent ? CURRENT_REVISION_REMEDY : PAST_REVISION_REMEDY;
}

function revisionTruncation(
	itemNoun: string,
	returnedBytes: number,
	totalBytes: number,
	isCurrent: boolean | undefined,
): TruncationInfo {
	return {
		reason: 'content-truncated',
		returnedBytes,
		totalBytes,
		itemNoun,
		toolName: 'get-revision',
		remedyHint: remedyFor(isCurrent),
	};
}

const inputSchema = {
	revisionId: z.number().int().positive().describe('Revision ID'),
	content: z
		.nativeEnum(ContentFormat)
		.describe('Type of content to return')
		.optional()
		.default(ContentFormat.source),
	metadata: z
		.boolean()
		.describe(
			'Whether to include metadata (revision ID, page ID, page title, user ID, user name, timestamp, comment, size, minor, HTML URL) in the response',
		)
		.optional()
		.default(false),
} as const;

export const getRevision: Tool<typeof inputSchema> = {
	name: 'get-revision',
	description:
		'Returns a specific historical revision of a wiki page by revision ID (wikitext source, rendered HTML, or metadata only). If the revision ID does not exist, an error is returned. Content is truncated at 75000 bytes by default; a past revision has no narrower read, so for a large one use compare-pages to see what changed. For the latest revision plus metadata, use get-page with metadata=true.',
	inputSchema,
	annotations: {
		title: 'Get revision',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve revision data',
	target: (a) => String(a.revisionId),

	async handle({ revisionId, content, metadata }, ctx: ToolContext): Promise<CallToolResult> {
		if (content === ContentFormat.none && !metadata) {
			return ctx.format.invalidInput('When content is set to "none", metadata must be true');
		}

		const mwn = await ctx.mwn();
		const payload: {
			revisionId?: number;
			pageId?: number;
			title?: string;
			url?: string;
			userid?: number;
			user?: string;
			timestamp?: string;
			comment?: string;
			size?: number;
			minor?: boolean;
			contentModel?: string;
			source?: string;
			html?: string;
			truncation?: TruncationInfo;
		} = {};

		// Left undefined when nothing this call does reveals it.
		let isCurrentRevision: boolean | undefined;
		const needsSource = content === ContentFormat.source;
		const needsMetadata = metadata || content === ContentFormat.none;

		if (needsSource || needsMetadata) {
			const rvprop = needsSource
				? 'ids|timestamp|user|userid|comment|size|flags|content'
				: 'ids|timestamp|user|userid|comment|size|flags';

			const response = await mwn.request({
				action: 'query',
				prop: 'revisions|info',
				revids: revisionId,
				rvprop,
				formatversion: '2',
			});

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			const page = response.query?.pages?.[0] as (ApiPage & { lastrevid?: number }) | undefined;
			const rev: ApiRevision | undefined = page?.revisions?.[0];
			if (rev?.revid !== undefined && page?.lastrevid !== undefined) {
				isCurrentRevision = rev.revid === page.lastrevid;
			}

			if (!rev || !page || page.missing) {
				return ctx.format.notFound(`Revision ${revisionId} not found`);
			}

			payload.revisionId = rev.revid;
			payload.pageId = page.pageid;
			payload.title = page.title;
			payload.url = await buildPageUrl(ctx, page.title);

			if (needsMetadata) {
				payload.userid = rev.userid;
				payload.user = rev.user;
				payload.timestamp = rev.timestamp;
				payload.comment = rev.comment;
				payload.size = rev.size;
				payload.minor = rev.minor ?? false;
			}

			if (needsSource && rev.content !== undefined) {
				const truncated = truncateByBytes(rev.content);
				payload.source = truncated.text;
				if (truncated.truncated) {
					payload.truncation = revisionTruncation(
						'wikitext',
						truncated.returnedBytes,
						truncated.totalBytes,
						isCurrentRevision,
					);
				}
			}
		}

		if (content === ContentFormat.html) {
			const parseResult = await mwn.request({
				action: 'parse',
				oldid: revisionId,
				prop: 'text',
				formatversion: '2',
			});
			const html: string | undefined = parseResult.parse?.text;
			if (html !== undefined) {
				const truncated = truncateByBytes(html);
				payload.html = truncated.text;
				if (truncated.truncated) {
					payload.truncation = revisionTruncation(
						'HTML',
						truncated.returnedBytes,
						truncated.totalBytes,
						isCurrentRevision,
					);
				}
			}

			if (payload.revisionId === undefined) {
				payload.revisionId = revisionId;
				if (parseResult.parse?.pageid !== undefined) {
					payload.pageId = parseResult.parse.pageid;
				}
				if (parseResult.parse?.title !== undefined) {
					payload.title = parseResult.parse.title;
					payload.url = await buildPageUrl(ctx, parseResult.parse.title);
				}
			}
		}

		return ctx.format.ok(payload);
	},
};
