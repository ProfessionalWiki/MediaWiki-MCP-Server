import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ApiRevision, Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { renderPage, type RenderedPage } from '../wikis/readPage.ts';
import { ContentFormat } from '../results/contentFormat.ts';
import {
	truncateByBytes,
	type TruncatedContent,
	type TruncationInfo,
} from '../results/truncation.ts';

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

type GetRevisionArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface RevisionPayload {
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
	source?: string;
	html?: string;
	truncation?: TruncationInfo;
}

interface PageRevision {
	page: ApiPage;
	revision: ApiRevision;
	isCurrent: boolean | undefined;
}

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

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const validationError = validateArgs(args);
		if (validationError !== undefined) {
			return ctx.format.invalidInput(validationError);
		}

		const mwn = await ctx.mwn();
		if (!needsRevisionQuery(args)) {
			return ctx.format.ok(await htmlPayload(mwn, args, ctx, undefined));
		}

		const revision = await queryRevision(mwn, args);
		if (revision === undefined) {
			return ctx.format.notFound(`Revision ${args.revisionId} not found`);
		}
		return ctx.format.ok({
			...(await revisionPayload(revision, args, ctx)),
			...(args.content === ContentFormat.html
				? await htmlPayload(mwn, args, ctx, revision.isCurrent)
				: {}),
		});
	},
};

function validateArgs({ content, metadata }: GetRevisionArgs): string | undefined {
	if (content === ContentFormat.none && !metadata) {
		return 'When content is set to "none", metadata must be true';
	}
	return undefined;
}

function needsRevisionQuery({ content, metadata }: GetRevisionArgs): boolean {
	return metadata || content !== ContentFormat.html;
}

async function queryRevision(
	mwn: Mwn,
	{ revisionId, content }: GetRevisionArgs,
): Promise<PageRevision | undefined> {
	const response = await mwn.request({
		action: 'query',
		prop: 'revisions|info',
		revids: revisionId,
		rvprop:
			content === ContentFormat.source
				? 'ids|timestamp|user|userid|comment|size|flags|content'
				: 'ids|timestamp|user|userid|comment|size|flags',
		formatversion: '2',
	});

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
	const page = response.query?.pages?.[0] as (ApiPage & { lastrevid?: number }) | undefined;
	const revision = page?.revisions?.[0];
	if (!revision || !page || page.missing) {
		return undefined;
	}
	return { page, revision, isCurrent: isCurrentRevision(revision, page.lastrevid) };
}

function isCurrentRevision(
	revision: ApiRevision,
	lastRevisionId: number | undefined,
): boolean | undefined {
	if (revision.revid === undefined || lastRevisionId === undefined) {
		return undefined;
	}
	return revision.revid === lastRevisionId;
}

async function revisionPayload(
	{ page, revision, isCurrent }: PageRevision,
	args: GetRevisionArgs,
	ctx: ToolContext,
): Promise<RevisionPayload> {
	return {
		revisionId: revision.revid,
		pageId: page.pageid,
		title: page.title,
		url: await buildPageUrl(ctx, page.title),
		...(args.metadata ? revisionMetadata(revision) : {}),
		...(args.content === ContentFormat.source ? sourcePayload(revision.content, isCurrent) : {}),
	};
}

function revisionMetadata(revision: ApiRevision): RevisionPayload {
	return {
		userid: revision.userid,
		user: revision.user,
		timestamp: revision.timestamp,
		comment: revision.comment,
		size: revision.size,
		minor: revision.minor ?? false,
	};
}

function sourcePayload(
	content: string | undefined,
	isCurrent: boolean | undefined,
): RevisionPayload {
	if (content === undefined) {
		return {};
	}
	const source = truncateByBytes(content);
	return { source: source.text, ...truncationPayload(source, 'wikitext', isCurrent) };
}

function truncationPayload(
	content: TruncatedContent,
	itemNoun: string,
	isCurrent: boolean | undefined,
): RevisionPayload {
	if (!content.truncated) {
		return {};
	}
	return {
		truncation: {
			reason: 'content-truncated',
			returnedBytes: content.returnedBytes,
			totalBytes: content.totalBytes,
			itemNoun,
			toolName: 'get-revision',
			remedyHint: remedyFor(isCurrent),
		},
	};
}

function remedyFor(isCurrent: boolean | undefined): string {
	if (isCurrent === undefined) {
		return UNKNOWN_REVISION_REMEDY;
	}
	return isCurrent ? CURRENT_REVISION_REMEDY : PAST_REVISION_REMEDY;
}

async function htmlPayload(
	mwn: Mwn,
	args: GetRevisionArgs,
	ctx: ToolContext,
	isCurrent: boolean | undefined,
): Promise<RevisionPayload> {
	const rendered = await renderPage(mwn, { oldid: args.revisionId });
	return {
		...renderedHtml(rendered.html, isCurrent),
		// Without metadata, the render is the only read that names the revision.
		...(args.metadata ? {} : await renderedRevisionIdentity(rendered, args.revisionId, ctx)),
	};
}

function renderedHtml(html: string | undefined, isCurrent: boolean | undefined): RevisionPayload {
	if (html === undefined) {
		return {};
	}
	const capped = truncateByBytes(html);
	return { html: capped.text, ...truncationPayload(capped, 'HTML', isCurrent) };
}

async function renderedRevisionIdentity(
	rendered: RenderedPage,
	revisionId: number,
	ctx: ToolContext,
): Promise<RevisionPayload> {
	return {
		revisionId,
		pageId: rendered.pageId,
		...(rendered.title !== undefined
			? { title: rendered.title, url: await buildPageUrl(ctx, rendered.title) }
			: {}),
	};
}
