import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ApiParams, ApiRevision, Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { readPage, renderPage, type RenderedPage } from '../wikis/readPage.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import {
	truncateByBytes,
	type TruncatedContent,
	type TruncationInfo,
} from '../results/truncation.ts';
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

type GetPageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface PagePayload {
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
}

type SectionLister = () => Promise<SectionEntry[]>;

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

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const validationError = validateArgs(args);
		if (validationError !== undefined) {
			return ctx.format.invalidInput(validationError);
		}

		const mwn = await ctx.mwn();
		const listSections = listSectionsOnce(ctx, mwn, args.title);
		if (!needsPageRead(args)) {
			return ctx.format.ok(await htmlPayload(mwn, args, ctx, listSections));
		}

		const page = await readPage(mwn, args.title, pageReadParams(args));
		if (page.missing) {
			return ctx.format.notFound(`Page "${args.title}" not found`);
		}
		return ctx.format.ok({
			...(await pageReadPayload(page, args, ctx, listSections)),
			...(args.content === ContentFormat.html
				? await htmlPayload(mwn, args, ctx, listSections)
				: {}),
		});
	},
};

function validateArgs({ content, metadata, section }: GetPageArgs): string | undefined {
	if (content === ContentFormat.none && !metadata) {
		return 'When content is set to "none", metadata must be true';
	}
	if (section !== undefined && content === ContentFormat.none) {
		return 'section is not compatible with content="none"';
	}
	return undefined;
}

function listSectionsOnce(ctx: ToolContext, mwn: Mwn, title: string): SectionLister {
	let entries: Promise<SectionEntry[]> | undefined;
	return () => (entries ??= ctx.sections.list(mwn, title));
}

function needsPageRead({ content, metadata }: GetPageArgs): boolean {
	return metadata || content !== ContentFormat.html;
}

function pageReadParams({ content, section }: GetPageArgs): ApiParams & { redirects: boolean } {
	if (content === ContentFormat.source) {
		return {
			rvprop: 'ids|timestamp|contentmodel|size|content',
			redirects: true,
			...(section !== undefined ? { rvsection: section } : {}),
		};
	}
	return { rvprop: 'ids|timestamp|contentmodel|size', redirects: true };
}

async function pageReadPayload(
	page: ApiPage,
	args: GetPageArgs,
	ctx: ToolContext,
	listSections: SectionLister,
): Promise<PagePayload> {
	const revision = page.revisions?.[0];
	const readsSource = args.content === ContentFormat.source;
	return {
		// A write scoped to a section needs the revision its section number was read from.
		...(readsSource ? { latestRevisionId: revision?.revid } : {}),
		...(args.metadata ? await metadataPayload(page, revision, ctx, listSections) : {}),
		...(readsSource ? await sourcePayload(revision?.content, args.section, listSections) : {}),
	};
}

async function metadataPayload(
	page: ApiPage,
	revision: ApiRevision | undefined,
	ctx: ToolContext,
	listSections: SectionLister,
): Promise<PagePayload> {
	return {
		pageId: page.pageid,
		title: page.title,
		latestRevisionId: revision?.revid,
		latestRevisionTimestamp: revision?.timestamp,
		contentModel: revision?.contentmodel,
		size: revision?.size,
		sections: toOutlineLines(await listSections()),
		url: await buildPageUrl(ctx, page.title),
	};
}

async function sourcePayload(
	content: string | undefined,
	section: number | undefined,
	listSections: SectionLister,
): Promise<PagePayload> {
	if (content === undefined) {
		return {};
	}
	const source = truncateByBytes(content);
	return {
		source: source.text,
		...(await truncationPayload(source, 'wikitext', section, listSections)),
	};
}

async function truncationPayload(
	content: TruncatedContent,
	itemNoun: string,
	section: number | undefined,
	listSections: SectionLister,
): Promise<PagePayload> {
	if (!content.truncated) {
		return {};
	}
	return {
		truncation: sectionContentTruncation({
			entries: await listSections(),
			section,
			itemNoun,
			toolName: 'get-page',
			returnedBytes: content.returnedBytes,
			totalBytes: content.totalBytes,
		}),
	};
}

async function htmlPayload(
	mwn: Mwn,
	args: GetPageArgs,
	ctx: ToolContext,
	listSections: SectionLister,
): Promise<PagePayload> {
	const rendered = await renderPage(mwn, {
		page: args.title,
		...(args.section !== undefined ? { section: args.section } : {}),
	});
	if (rendered.html === undefined) {
		return {};
	}
	const html = truncateByBytes(rendered.html);
	return {
		html: html.text,
		// Without metadata, the render is the only read that names the page.
		...(args.metadata ? {} : await renderedPageIdentity(rendered, args.title, ctx)),
		...(await truncationPayload(html, 'HTML', args.section, listSections)),
	};
}

async function renderedPageIdentity(
	rendered: RenderedPage,
	requestedTitle: string,
	ctx: ToolContext,
): Promise<PagePayload> {
	const title = rendered.title ?? requestedTitle;
	return {
		title,
		pageId: rendered.pageId,
		url: await buildPageUrl(ctx, title),
	};
}
