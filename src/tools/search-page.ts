import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiResponse, ApiSearchResult } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
import { resolveSiteInfo } from '../wikis/siteInfo.ts';
import type { TruncationInfo } from '../results/truncation.ts';

const inputSchema = {
	query: z.string().describe('Search terms'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Maximum number of search results to return'),
	namespaces: z
		.array(z.number().int().nonnegative())
		.nonempty()
		.optional()
		.describe('Namespace IDs to search — e.g. [0, 12] for main and help'),
} as const;

export const searchPage: Tool<typeof inputSchema> = {
	name: 'search-page',
	description:
		"Searches wiki page titles and page content (full-text) for the provided terms. Returns matching pages with a snippet, size, timestamp, and the namespace the match came from. Covers the namespaces the wiki counts as content unless namespaces names the namespace IDs to search; get-site-info lists a wiki's namespaces and flags which of them hold content. Accepts up to 100 matches per call (default 10); additional matches beyond the cap are flagged in the response — narrow the query to surface more. For title-prefix lookup (e.g. autocomplete), use search-page-by-prefix.",
	inputSchema,
	annotations: {
		title: 'Search page',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve search data',
	target: (a) => a.query,

	async handle({ query, limit, namespaces }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const scope = await resolveScope(ctx, namespaces);

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'search',
			srsearch: query,
			srwhat: 'text',
			srprop: 'snippet|size|timestamp|wordcount',
			formatversion: '2',
		};

		if (limit !== undefined) {
			params.srlimit = limit;
		}
		// CirrusSearch reads an empty value as every namespace, not none.
		if (scope.namespaces.length > 0) {
			params.srnamespace = scope.namespaces.join('|');
		}

		const response = await mwn.request(params);
		const searchResults: ApiSearchResult[] = response.query?.search ?? [];

		const truncation: TruncationInfo | null = response.continue
			? {
					reason: 'capped-no-continuation',
					returnedCount: searchResults.length,
					limit: limit ?? 10,
					itemNoun: 'matches',
					narrowHint: 'narrow the query or raise limit (max 100)',
				}
			: null;

		const results = await Promise.all(
			searchResults.map(async (r) => ({
				title: r.title,
				pageId: r.pageid,
				namespace: r.ns,
				snippet: r.snippet,
				size: r.size,
				wordCount: (r as ApiSearchResult & { wordcount?: number }).wordcount,
				timestamp: r.timestamp,
				url: await buildPageUrl(ctx, r.title),
			})),
		);

		const scopeNotice = describeScopeLoss(scope, searchResults, searchWarning(response));

		return ctx.format.ok({
			results,
			...(scopeNotice !== null ? { scopeNotice } : {}),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

// Above this the wiki errors, naming a parameter the caller never sent.
const MAX_NAMESPACE_VALUES = 50;

interface SearchScope {
	/** What reached srnamespace. Empty means the parameter was omitted. */
	readonly namespaces: readonly number[];
	readonly origin: 'caller' | 'wiki';
	/** Content namespaces the value cap left out. */
	readonly dropped: number;
}

// A wiki that reports no namespace map leaves the scope unresolved, and the
// search falls back to MediaWiki's own default of the main namespace.
async function resolveScope(
	ctx: ToolContext,
	requested: readonly number[] | undefined,
): Promise<SearchScope> {
	if (requested !== undefined) {
		return { namespaces: requested, origin: 'caller', dropped: 0 };
	}

	const { key } = ctx.activeWiki.get();
	const contentNamespaces = (await resolveSiteInfo(ctx, key)).contentNamespaces ?? [];

	return {
		namespaces: contentNamespaces.slice(0, MAX_NAMESPACE_VALUES),
		origin: 'wiki',
		dropped: Math.max(0, contentNamespaces.length - MAX_NAMESPACE_VALUES),
	};
}

// Every way the effective scope can differ from the intended one. The prefix
// override is the caller's own doing, so it is reported only against a scope
// the caller named.
function describeScopeLoss(
	scope: SearchScope,
	results: readonly ApiSearchResult[],
	warning: string | undefined,
): string | null {
	const parts: string[] = [];

	if (warning !== undefined) {
		const scopeSource =
			scope.origin === 'wiki' && scope.namespaces.length > 0
				? `Searched this wiki's content namespaces (${scope.namespaces.join(', ')}) by default. `
				: '';
		parts.push(`${scopeSource}The wiki reported: ${warning}`);
	}

	// MediaWiki always counts the main namespace as content, so an empty
	// wiki-derived scope means siteinfo could not be read. Only an empty result
	// leaves the caller unable to tell that apart from a wiki whose content
	// really is main-namespace-only; a result carries its own namespace.
	if (scope.origin === 'wiki' && scope.namespaces.length === 0 && results.length === 0) {
		parts.push(
			"Could not read this wiki's content namespaces, so the search covered the main namespace only — name the namespaces to search to widen it.",
		);
	}

	if (scope.dropped > 0) {
		parts.push(
			`This wiki has ${scope.namespaces.length + scope.dropped} content namespaces and the search accepts ${MAX_NAMESPACE_VALUES}, so ${scope.dropped} of them were not searched — name the namespaces to search to choose which.`,
		);
	}

	if (scope.origin === 'caller') {
		const unexpected = [...new Set(results.map((r) => r.ns))].filter(
			(ns) => !scope.namespaces.includes(ns),
		);
		if (unexpected.length > 0) {
			parts.push(
				`Requested namespaces ${scope.namespaces.join(', ')}, but results include ${unexpected.join(', ')} — a namespace prefix in the query (such as "Help:") overrides the namespaces argument.`,
			);
		}
	}

	return parts.length > 0 ? parts.join(' ') : null;
}

// The API reports an unusable parameter under the module that received it,
// leaving the response otherwise successful.
function searchWarning(response: ApiResponse): string | undefined {
	const { warnings } = response;
	if (!isRecord(warnings) || !isRecord(warnings.search)) {
		return undefined;
	}

	const warning = warnings.search.warnings;
	return typeof warning === 'string' && warning !== '' ? warning : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
