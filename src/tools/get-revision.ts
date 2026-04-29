import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiPage, ApiRevision } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { getPageUrl } from '../wikis/utils.js';
import { ContentFormat } from '../results/contentFormat.js';

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
		'Returns a specific historical revision of a wiki page by revision ID (wikitext source, rendered HTML, or metadata only). If the revision ID does not exist, an error is returned. For the latest revision plus metadata, use get-page with metadata=true.',
	inputSchema,
	annotations: {
		title: 'Get revision',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
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
			payload.url = getPageUrl(page.title);

			if (needsMetadata) {
				payload.userid = rev.userid;
				payload.user = rev.user;
				payload.timestamp = rev.timestamp;
				payload.comment = rev.comment;
				payload.size = rev.size;
				payload.minor = rev.minor ?? false;
			}

			if (needsSource && rev.content !== undefined) {
				payload.source = rev.content;
			}
		}

		if (content === ContentFormat.html) {
			const parseResult = await mwn.request({
				action: 'parse',
				oldid: revisionId,
				prop: 'text',
				formatversion: '2',
			});
			payload.html = parseResult.parse?.text;

			if (payload.revisionId === undefined) {
				payload.revisionId = revisionId;
				if (parseResult.parse?.pageid !== undefined) {
					payload.pageId = parseResult.parse.pageid;
				}
				if (parseResult.parse?.title !== undefined) {
					payload.title = parseResult.parse.title;
					payload.url = getPageUrl(parseResult.parse.title);
				}
			}
		}

		return ctx.format.ok(payload);
	},
};
