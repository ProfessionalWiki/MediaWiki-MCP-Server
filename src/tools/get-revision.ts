import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ApiRevision } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.ts';

// A revision that is not the current one has no narrower read: `section=`
// addresses the page as it stands, not as it stood.
const NO_NARROWER_READ =
	'No narrower read of a past revision is available. To see what changed between revisions, use compare-pages.';

function revisionTruncation(
	itemNoun: string,
	returnedBytes: number,
	totalBytes: number,
): TruncationInfo {
	return {
		reason: 'content-truncated',
		returnedBytes,
		totalBytes,
		itemNoun,
		toolName: 'get-revision',
		remedyHint: NO_NARROWER_READ,
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
		'Returns a specific historical revision of a wiki page by revision ID (wikitext source, rendered HTML, or metadata only). If the revision ID does not exist, an error is returned. Content is truncated at 100000 bytes by default; a past revision has no narrower read, so for a large one use compare-pages to see what changed. For the latest revision plus metadata, use get-page with metadata=true.',
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

		const needsSource = content === ContentFormat.source;
		const needsMetadata = metadata || content === ContentFormat.none;

		if (needsSource || needsMetadata) {
			const rvprop = needsSource
				? 'ids|timestamp|user|userid|comment|size|flags|content'
				: 'ids|timestamp|user|userid|comment|size|flags';

			const response = await mwn.request({
				action: 'query',
				prop: 'revisions',
				revids: revisionId,
				rvprop,
				formatversion: '2',
			});

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			const page = response.query?.pages?.[0] as ApiPage | undefined;
			const rev: ApiRevision | undefined = page?.revisions?.[0];

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
