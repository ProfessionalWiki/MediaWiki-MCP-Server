import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.ts';
import { toOutlineLines, type SectionEntry } from '../services/sectionService.ts';
import { sectionContentTruncation } from '../services/sectionMarker.ts';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	content: z
		.nativeEnum(ContentFormat)
		.optional()
		.default(ContentFormat.source)
		.describe('Type of content to return'),
	metadata: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Whether to include metadata (page ID, revision info, size, section outline) in the response',
		),
	section: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			'Section number (0 = lead; 1..N = heading sections). Narrows content to one section.',
		),
} as const;

export const getPage: Tool<typeof inputSchema> = {
	name: 'get-page',
	description:
		'Returns a single wiki page (wikitext source, rendered HTML, or metadata only). If the title does not exist, an error is returned. Use metadata=true to retrieve the revision ID (for edit-conflict detection), page size, and section outline. Set content="none" to fetch only metadata. Large content is truncated at 75000 bytes by default, with a marker reporting how much of it was returned and which sections a narrower read can target; a follow-up call with section=N fetches a specific section. For more than one page at a time, use get-pages. For a specific historical revision, use get-revision.',
	inputSchema,
	annotations: {
		title: 'Get page',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve page data',
	target: (a) => a.title,

	async handle({ title, content, metadata, section }, ctx: ToolContext): Promise<CallToolResult> {
		if (content === ContentFormat.none && !metadata) {
			return ctx.format.invalidInput('When content is set to "none", metadata must be true');
		}
		if (section !== undefined && content === ContentFormat.none) {
			return ctx.format.invalidInput('section is not compatible with content="none"');
		}

		const mwn = await ctx.mwn();

		const payload: {
			pageId?: number;
			title?: string;
			latestRevisionId?: number;
			latestRevisionTimestamp?: string;
			contentModel?: string;
			size?: number;
			url?: string;
			sections?: string[];
			source?: string;
			html?: string;
			truncation?: TruncationInfo;
		} = {};

		const needsReadCall =
			metadata || content === ContentFormat.source || content === ContentFormat.none;
		const needsSource = content === ContentFormat.source;

		let entries: SectionEntry[] | undefined;

		if (needsReadCall) {
			const rvprop = needsSource
				? 'ids|timestamp|contentmodel|size|content'
				: 'ids|timestamp|contentmodel|size';
			const readParams: Record<string, string | number> = { rvprop };
			if (needsSource && section !== undefined) {
				readParams.rvsection = section;
			}
			const page = await mwn.read(title, readParams);

			if (page.missing) {
				return ctx.format.notFound(`Page "${title}" not found`);
			}

			const rev = page.revisions?.[0];

			if (metadata) {
				entries = await ctx.sections.list(mwn, title);
			}

			// The revision ID rides on every read that fetches content, and a write
			// scoped to a section needs it to say which revision its section
			// number was read from. Withholding it behind metadata=true made the
			// natural read-modify-write sequence fail on the write and then need a
			// second read to recover, so it is reported whenever content is.
			if (needsSource && rev?.revid !== undefined) {
				payload.latestRevisionId = rev.revid;
			}

			if (metadata || content === ContentFormat.none) {
				payload.pageId = page.pageid;
				payload.title = page.title;
				payload.latestRevisionId = rev?.revid;
				payload.latestRevisionTimestamp = rev?.timestamp;
				payload.contentModel = rev?.contentmodel;
				if (rev?.size !== undefined) {
					payload.size = rev.size;
				}
				if (entries !== undefined) {
					payload.sections = toOutlineLines(entries);
				}
				payload.url = await buildPageUrl(ctx, page.title);
			}

			if (needsSource && rev?.content !== undefined) {
				const truncated = truncateByBytes(rev.content);
				payload.source = truncated.text;
				if (truncated.truncated) {
					entries ??= await ctx.sections.list(mwn, title);
					payload.truncation = sectionContentTruncation({
						entries,
						section,
						itemNoun: 'wikitext',
						toolName: 'get-page',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
					});
				}
			}
		}

		if (content === ContentFormat.html) {
			const parseParams: Record<string, string | number> = {
				action: 'parse',
				page: title,
				prop: 'text',
				formatversion: '2',
			};
			if (section !== undefined) {
				parseParams.section = section;
			}
			const parseResult = await mwn.request(parseParams);
			const html: string | undefined = parseResult.parse?.text;

			if (html !== undefined) {
				const truncated = truncateByBytes(html);
				payload.html = truncated.text;

				if (payload.title === undefined) {
					const resolvedTitle: string = parseResult.parse?.title ?? title;
					payload.title = resolvedTitle;
					if (parseResult.parse?.pageid !== undefined) {
						payload.pageId = parseResult.parse.pageid;
					}
					payload.url = await buildPageUrl(ctx, resolvedTitle);
				}

				if (truncated.truncated) {
					entries ??= await ctx.sections.list(mwn, title);
					payload.truncation = sectionContentTruncation({
						entries,
						section,
						itemNoun: 'HTML',
						toolName: 'get-page',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
					});
				}
			}
		}

		return ctx.format.ok(payload);
	},
};
