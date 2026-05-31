import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

export enum LinkType {
	wikilinks = 'wikilinks',
	transclusions = 'transclusions',
	fileusage = 'fileusage',
}

export enum RedirectFilter {
	all = 'all',
	redirects = 'redirects',
	nonredirects = 'nonredirects',
}

// Each relationship maps to a MediaWiki list module, its parameter prefix, and
// whether that module supports redirect expansion (embeddedin does not).
const MODULES = {
	[LinkType.wikilinks]: { list: 'backlinks', prefix: 'bl', canExpand: true },
	[LinkType.transclusions]: { list: 'embeddedin', prefix: 'ei', canExpand: false },
	[LinkType.fileusage]: { list: 'imageusage', prefix: 'iu', canExpand: true },
} as const;

// MediaWiki halves the per-level limit when redirect expansion is enabled, so a
// requested 500 would exceed the ceiling. Clamp what we send in that case.
const EXPANDED_LIMIT_CAP = 250;

interface ApiLink {
	pageid: number;
	ns: number;
	title: string;
	redirect?: boolean;
	redirlinks?: ApiLink[];
}

const inputSchema = {
	title: z
		.string()
		.describe(
			'Wiki page title to find references to (the link target). A File title when type is fileusage.',
		),
	type: z
		.nativeEnum(LinkType)
		.default(LinkType.wikilinks)
		.describe(
			'Inbound relationship to list: wikilinks (pages that link to the target), transclusions (pages that embed it), or fileusage (pages that display it)',
		),
	namespaces: z
		.array(z.number().int().nonnegative())
		.optional()
		.describe('Namespace IDs to filter the referencing pages by'),
	filter: z
		.nativeEnum(RedirectFilter)
		.default(RedirectFilter.all)
		.describe('Filter the referencing pages by redirect status'),
	expandRedirects: z
		.boolean()
		.default(true)
		.describe(
			'When a referencing page is a redirect to the target, also return the pages that link through it. Applies to wikilinks and fileusage only.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe('Maximum referencing pages to return (1..500)'),
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque continuation token from the previous response; omit on first call'),
} as const;

export const getLinksHere: Tool<typeof inputSchema> = {
	name: 'get-links-here',
	description:
		"Lists pages that reference a target wiki page, returning each referencing page's title, page ID, namespace ID, and whether it is a redirect. The type parameter selects the relationship — wikilinks (pages that link to the target), transclusions (pages that embed it, such as a template), or fileusage (pages that display it, for File pages) — one relationship per call. With expandRedirects, a referencing redirect also yields the pages that link through it (wikilinks and fileusage only), each tagged with the via redirect. Filter by namespace ID or by redirect status. For members of a category, use get-category-members; for full-text content search, use search-page. Returns up to 500 per call; paginate with continueFrom. The redirect flag appears only when the referencing page is a redirect.",
	inputSchema,
	annotations: {
		title: 'Get links here',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve links',
	target: (a) => a.title,

	async handle(
		{ title, type, namespaces, filter, expandRedirects, limit, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const { list, prefix, canExpand } = MODULES[type];
		const doExpand = canExpand && expandRedirects;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list,
			[`${prefix}title`]: title,
			formatversion: '2',
		};
		if (namespaces && namespaces.length > 0) {
			params[`${prefix}namespace`] = namespaces.join('|');
		}
		if (filter !== RedirectFilter.all) {
			params[`${prefix}filterredir`] = filter;
		}
		// With expansion on, MediaWiki halves the per-level cap to 250; clamp so a
		// requested 500 doesn't get rejected.
		const requested = limit ?? 500;
		params[`${prefix}limit`] = doExpand ? Math.min(requested, EXPANDED_LIMIT_CAP) : requested;
		if (doExpand) {
			params[`${prefix}redirect`] = true;
		}
		if (continueFrom) {
			params[`${prefix}continue`] = continueFrom;
		}

		const response = await mwn.request(params);
		// A nonexistent target is a valid query (red links point to not-yet-created
		// titles); the list modules return an empty array rather than erroring.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const raw: ApiLink[] = (response.query?.[list] ?? []) as ApiLink[];

		// Flatten one level: each redirect entry's redirlinks become indirect
		// entries tagged with the via redirect that mediates them. Transclusions
		// never carry redirlinks, so this is a no-op there.
		const links = raw.flatMap((entry) => {
			const base = {
				title: entry.title,
				pageId: entry.pageid,
				namespace: entry.ns,
				...(entry.redirect ? { redirect: true } : {}),
			};
			const indirect = (entry.redirlinks ?? []).map((child) => ({
				title: child.title,
				pageId: child.pageid,
				namespace: child.ns,
				...(child.redirect ? { redirect: true } : {}),
				via: entry.title,
			}));
			return [base, ...indirect];
		});

		const nextCursor: string | undefined = response.continue?.[`${prefix}continue`];
		const truncation: TruncationInfo | null = nextCursor
			? {
					reason: 'more-available',
					returnedCount: links.length,
					itemNoun: 'links',
					toolName: 'get-links-here',
					continueWith: { param: 'continueFrom', value: nextCursor },
				}
			: null;

		return ctx.format.ok({
			links,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
