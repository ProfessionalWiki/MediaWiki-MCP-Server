import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { contentMaxBytes, truncateByBytes, type TruncationInfo } from '../results/truncation.ts';
import { sectionContentTruncation } from '../services/sectionMarker.ts';

const MAX_TITLES = 50;

export enum BatchContentFormat {
	source = 'source',
	none = 'none',
}

interface PageEntry {
	requestedTitle?: string;
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
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		for (const entry of (query.normalized ?? []) as Alias[]) {
			result.aliasTo.set(entry.from, entry.to);
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		for (const entry of (query.redirects ?? []) as Alias[]) {
			result.aliasTo.set(entry.from, entry.to);
			result.redirectFrom.add(entry.from);
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		for (const page of (query.pages ?? []) as ApiPageLike[]) {
			result.byResolvedTitle.set(page.title, normalisePage(page, ctx));
		}
	}
	return result;
}

async function buildPageEntry(
	requested: string,
	page: ApiPageLike,
	viaRedirect: boolean,
	args: GetPagesArgs,
	entryIndex: number,
	pending: PendingTruncation[],
	ctx: ToolContext,
): Promise<PageEntry> {
	const rev = page.revisions?.[0];
	const entry: PageEntry = {
		pageId: page.pageid,
		title: page.title,
		url: await buildPageUrl(ctx, page.title),
		...(requested !== page.title ? { requestedTitle: requested } : {}),
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
		entry.source = rev.content;
	}
	return entry;
}

// The byte budget is a response budget, not a per-body one: it was applied to
// each body on its own, so a call for the maximum 50 titles could return 50
// times it.
//
// Pages are kept whole, in the order asked for, while the bodies returned stay
// inside the budget; the first page that does not fit ends the response and it
// and the rest are named instead. Cutting into a page nobody can finish reading
// serves no one, and this tool is used to sync and diff whole pages. The one
// exception is a first page larger than the whole budget, which is cut rather
// than dropped, so a caller still receives something. At most one page's body
// is ever cut, and it is always the first. Only bodies are counted; the
// metadata around them is small and fixed.
function applyResponseBudget(entries: PageEntry[], pending: PendingTruncation[]): string[] {
	const budget = contentMaxBytes();
	let used = 0;
	for (const [index, entry] of entries.entries()) {
		if (entry.source === undefined) {
			continue;
		}
		const size = Buffer.byteLength(entry.source, 'utf8');
		if (index === 0 && size > budget) {
			const truncated = truncateByBytes(entry.source, budget);
			entry.source = truncated.text;
			used = truncated.returnedBytes;
			// The outline behind the marker is fetched by title, so a page whose
			// title the API did not report is cut without one rather than sending
			// an empty title to the wiki.
			if (entry.title !== undefined) {
				pending.push({
					entryIndex: index,
					title: entry.title,
					returnedBytes: truncated.returnedBytes,
					totalBytes: truncated.totalBytes,
				});
			}
			continue;
		}
		if (used + size > budget) {
			const omitted = entries
				.slice(index)
				.map((e) => e.title ?? e.requestedTitle)
				.filter((t): t is string => t !== undefined);
			entries.length = index;
			return omitted;
		}
		used += size;
	}
	return [];
}

function omittedPagesTruncation(returnedCount: number, omitted: string[]): TruncationInfo {
	return {
		reason: 'capped-no-continuation',
		returnedCount,
		limit: returnedCount,
		itemNoun: 'pages',
		narrowHint: `the response byte budget was reached. Call get-pages again for the pages not returned: ${omitted.join(', ')}.`,
	};
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
	const outlines = await Promise.all(pending.map((p) => ctx.sections.list(mwn, p.title)));
	pending.forEach((p, i) => {
		entries[p.entryIndex].truncation = sectionContentTruncation({
			entries: outlines[i],
			// get-pages reads whole pages, so the narrowing on offer is always
			// the page's own sections.
			section: undefined,
			itemNoun: 'wikitext',
			toolName: 'get-pages',
			returnedBytes: p.returnedBytes,
			totalBytes: p.totalBytes,
		});
	});
}

async function assembleEntries(
	args: GetPagesArgs,
	fetched: FetchResult,
	ctx: ToolContext,
): Promise<{ entries: PageEntry[]; missing: string[]; pending: PendingTruncation[] }> {
	const entryPromises: Promise<PageEntry>[] = [];
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
		entryPromises.push(
			buildPageEntry(requested, page, viaRedirect, args, entryPromises.length, pending, ctx),
		);
	}
	const entries = await Promise.all(entryPromises);
	return { entries, missing, pending };
}

export const getPages: Tool<typeof inputSchema> = {
	name: 'get-pages',
	description: `Returns multiple wiki pages in one call (wikitext source or metadata only). Suited to reading a cluster of related pages, diffing a page family, or syncing pages to local storage. Accepts up to ${MAX_TITLES} titles; missing pages are reported inline (not as errors). One byte budget covers the whole response, 100000 bytes by default: pages come back whole in the order asked for until it is spent, and the pages past that point are named rather than returned, so a follow-up call for those names fetches the rest. Only a first page larger than the budget on its own is truncated, with a marker reporting how much of it was returned and which sections a narrower read can target. For a single page or HTML output, use get-page. requestedTitle is included only when it differs from the resolved title.`,
	inputSchema,
	annotations: {
		title: 'Get pages',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
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
		const { entries, missing, pending } = await assembleEntries(args, fetched, ctx);
		const omitted = applyResponseBudget(entries, pending);
		await applyTruncations(mwn, ctx, entries, pending);

		return ctx.format.ok({
			pages: entries,
			...(missing.length > 0 ? { missing } : {}),
			...(omitted.length > 0
				? { truncation: omittedPagesTruncation(entries.length, omitted) }
				: {}),
		});
	},
};
