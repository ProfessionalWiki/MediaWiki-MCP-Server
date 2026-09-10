import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiResponse, ApiSearchResult } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';
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
		"Searches wiki page titles and page content (full-text) for the provided terms. Returns matching pages with a snippet, size, timestamp, and the namespace the match came from. Covers the main namespace unless namespaces names the namespace IDs to search; get-site-info lists a wiki's namespaces, and a wiki that keeps its content outside the main namespace returns nothing until they are named. Accepts up to 100 matches per call (default 10); additional matches beyond the cap are flagged in the response — narrow the query to surface more. For title-prefix lookup (e.g. autocomplete), use search-page-by-prefix.",
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
		if (namespaces !== undefined) {
			params.srnamespace = namespaces.join('|');
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

		const scopeNotice = describeScopeLoss(namespaces, searchResults, searchWarning(response));

		return ctx.format.ok({
			results,
			...(scopeNotice !== null ? { scopeNotice } : {}),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

// Two different failures leave the caller reading results from a scope it did
// not ask for. The wiki reports an unusable namespace ID as an API warning and
// searches the rest; it reports nothing at all when a namespace prefix in the
// query overrides srnamespace, where the returned rows are the only evidence.
function describeScopeLoss(
	requested: readonly number[] | undefined,
	results: readonly ApiSearchResult[],
	warning: string | undefined,
): string | null {
	if (requested === undefined) {
		return null;
	}

	const parts: string[] = [];

	if (warning !== undefined) {
		parts.push(`The wiki reported: ${warning}`);
	}

	const unexpected = [...new Set(results.map((r) => r.ns))].filter((ns) => !requested.includes(ns));
	if (unexpected.length > 0) {
		parts.push(
			`Requested namespaces ${requested.join(', ')}, but results include ${unexpected.join(', ')} — a namespace prefix in the query (such as "Help:") overrides the namespaces argument.`,
		);
	}

	return parts.length > 0 ? parts.join(' ') : null;
}

// The action API reports a parameter it could not use under the module that
// received it, leaving the response otherwise successful.
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
