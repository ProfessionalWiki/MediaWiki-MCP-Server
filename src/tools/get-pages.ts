import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { getPageUrl } from '../wikis/utils.js';
import { truncateByBytes, type TruncationInfo } from '../results/truncation.js';

const MAX_TITLES = 50;

export enum BatchContentFormat {
	source = 'source',
	none = 'none',
}

interface PageEntry {
	requestedTitle: string;
	pageId?: number;
	title?: string;
	redirectedFrom?: string;
	latestRevisionId?: number;
	latestRevisionTimestamp?: string;
	contentModel?: string;
	url?: string;
	source?: string;
	truncation?: TruncationInfo;
}

interface PageRev {
	revid?: number;
	timestamp?: string;
	contentmodel?: string;
	content?: string;
	slots?: {
		main?: { contentmodel?: string; content?: string; size?: number };
	};
}

interface ApiPageLike {
	pageid: number;
	title: string;
	missing?: boolean;
	revisions?: PageRev[];
}

type FetchResult = {
	byResolvedTitle: Map<string, ApiPageLike>;
	aliasTo: Map<string, string>;
	redirectFrom: Set<string>;
};

type PendingTruncation = {
	entryIndex: number;
	title: string;
	returnedBytes: number;
	totalBytes: number;
};

const inputSchema = {
	titles: z.array(z.string()).describe(`Array of wiki page titles (1..${MAX_TITLES})`),
	content: z
		.nativeEnum(BatchContentFormat)
		.optional()
		.default(BatchContentFormat.source)
		.describe('Type of content to return; "none" returns metadata only'),
	metadata: z
		.boolean()
		.optional()
		.default(false)
		.describe('Whether to include metadata (page ID, revision info) in the response'),
	followRedirects: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Follow wiki redirects. When true (default), redirect targets are returned with a "Redirected from:" line in the metadata. Set false to fetch redirect pseudo-pages as-is (sync-fidelity).',
		),
} as const;

type GetPagesArgs = z.infer<z.ZodObject<typeof inputSchema>>;

function validateArgs({ titles, content, metadata }: GetPagesArgs): string | undefined {
	if (titles.length === 0) {
		return 'titles must contain at least one entry';
	}
	if (titles.length > MAX_TITLES) {
		return `titles must contain at most ${MAX_TITLES} entries`;
	}
	if (content === BatchContentFormat.none && !metadata) {
		return 'When content is set to "none", metadata must be true';
	}
	return undefined;
}

function resolveChain(
	requested: string,
	aliasTo: Map<string, string>,
	redirectFrom: Set<string>,
): { resolved: string; viaRedirect: boolean } {
	let cur = requested;
	let viaRedirect = false;
	const seen = new Set<string>();
	while (aliasTo.has(cur) && !seen.has(cur)) {
		seen.add(cur);
		if (redirectFrom.has(cur)) {
			viaRedirect = true;
		}
		cur = aliasTo.get(cur)!;
	}
	return { resolved: cur, viaRedirect };
}

function normalisePage(page: ApiPageLike, ctx: ToolContext): ApiPageLike {
	if (page.revisions) {
		page.revisions = page.revisions.map((rev) => ctx.revision.normalise(rev) as PageRev);
	}
	return page;
}

async function fetchPages(
	mwn: Mwn,
	ctx: ToolContext,
	args: GetPagesArgs,
	rvprop: string,
): Promise<FetchResult> {
	const result: FetchResult = {
		byResolvedTitle: new Map(),
		aliasTo: new Map(),
		redirectFrom: new Set(),
	};
	if (!args.followRedirects) {
		// mwn.read() defaults to following redirects, which would rewrite the requested
		// title to the target and break our lookup. Emit the redirect pseudo-page as-is.
		const response = await mwn.read(args.titles, { rvprop, redirects: false });
		const pages: ApiPageLike[] = Array.isArray(response) ? response : [response];
		for (const page of pages) {
			result.byResolvedTitle.set(page.title, normalisePage(page, ctx));
		}
		return result;
	}
	const responses = await mwn.massQuery(
		{
			action: 'query',
			titles: args.titles,
			prop: 'revisions',
			rvprop,
			rvslots: 'main',
			redirects: true,
			formatversion: '2',
		},
		'titles',
	);
	for (const response of responses) {
		const query = response?.query;
		if (!query) {
			continue;
		}
		type Alias = { from: string; to: string };
		for (const entry of (query.normalized ?? []) as Alias[]) {
			result.aliasTo.set(entry.from, entry.to);
		}
		for (const entry of (query.redirects ?? []) as Alias[]) {
			result.aliasTo.set(entry.from, entry.to);
			result.redirectFrom.add(entry.from);
		}
		for (const page of (query.pages ?? []) as ApiPageLike[]) {
			result.byResolvedTitle.set(page.title, normalisePage(page, ctx));
		}
	}
	return result;
}

function buildPageEntry(
	requested: string,
	page: ApiPageLike,
	viaRedirect: boolean,
	args: GetPagesArgs,
	entryIndex: number,
	pending: PendingTruncation[],
	ctx: ToolContext,
): PageEntry {
	const rev = page.revisions?.[0];
	const entry: PageEntry = {
		requestedTitle: requested,
		pageId: page.pageid,
		title: page.title,
		url: getPageUrl(page.title, ctx.selection),
		...(viaRedirect ? { redirectedFrom: requested } : {}),
		...(args.metadata
			? {
					latestRevisionId: rev?.revid,
					latestRevisionTimestamp: rev?.timestamp,
					contentModel: rev?.contentmodel,
				}
			: {}),
	};
	if (args.content === BatchContentFormat.source && rev?.content !== undefined) {
		const truncated = truncateByBytes(rev.content);
		entry.source = truncated.text;
		if (truncated.truncated) {
			pending.push({
				entryIndex,
				title: page.title,
				returnedBytes: truncated.returnedBytes,
				totalBytes: truncated.totalBytes,
			});
		}
	}
	return entry;
}

async function applyTruncations(
	mwn: Mwn,
	ctx: ToolContext,
	entries: PageEntry[],
	pending: PendingTruncation[],
): Promise<void> {
	if (pending.length === 0) {
		return;
	}
	const sectionLists = await Promise.all(pending.map((p) => ctx.sections.list(mwn, p.title)));
	pending.forEach((p, i) => {
		entries[p.entryIndex].truncation = {
			reason: 'content-truncated',
			returnedBytes: p.returnedBytes,
			totalBytes: p.totalBytes,
			itemNoun: 'wikitext',
			toolName: 'get-pages',
			sections: sectionLists[i],
			remedyHint: 'To read a specific section, call get-page again with section=N.',
		};
	});
}

function assembleEntries(
	args: GetPagesArgs,
	fetched: FetchResult,
	ctx: ToolContext,
): { entries: PageEntry[]; missing: string[]; pending: PendingTruncation[] } {
	const entries: PageEntry[] = [];
	const emitted = new Set<string>();
	const missing: string[] = [];
	const missingSeen = new Set<string>();
	const pending: PendingTruncation[] = [];
	for (const requested of args.titles) {
		const { resolved, viaRedirect } = args.followRedirects
			? resolveChain(requested, fetched.aliasTo, fetched.redirectFrom)
			: { resolved: requested, viaRedirect: false };
		const page = fetched.byResolvedTitle.get(resolved);
		if (!page || page.missing) {
			if (!missingSeen.has(requested)) {
				missingSeen.add(requested);
				missing.push(requested);
			}
			continue;
		}
		if (emitted.has(page.title)) {
			continue;
		}
		emitted.add(page.title);
		entries.push(buildPageEntry(requested, page, viaRedirect, args, entries.length, pending, ctx));
	}
	return { entries, missing, pending };
}

export const getPages: Tool<typeof inputSchema> = {
	name: 'get-pages',
	description: `Returns multiple wiki pages in one call (wikitext source or metadata only). Suited to reading a cluster of related pages, diffing a page family, or syncing pages to local storage. Accepts up to ${MAX_TITLES} titles; missing pages are reported inline (not as errors). Each page's content is truncated at 50000 bytes with a trailing marker listing available sections; get-page with section=N fetches a specific section. For a single page or HTML output, use get-page.`,
	inputSchema,
	annotations: {
		title: 'Get pages',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve pages',

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const validationError = validateArgs(args);
		if (validationError) {
			return ctx.format.invalidInput(validationError);
		}

		const mwn = await ctx.mwn();
		const rvprop =
			args.content === BatchContentFormat.source
				? 'ids|timestamp|contentmodel|content'
				: 'ids|timestamp|contentmodel';
		const fetched = await fetchPages(mwn, ctx, args, rvprop);
		const { entries, missing, pending } = assembleEntries(args, fetched, ctx);
		await applyTruncations(mwn, ctx, entries, pending);

		return ctx.format.ok({
			pages: entries,
			...(missing.length > 0 ? { missing } : {}),
		});
	},
};
