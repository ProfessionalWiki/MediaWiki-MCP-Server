import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { capLinesByBytes } from '../../../results/truncation.ts';
import { runSparqlQuery, SparqlError } from './sparql.ts';

const HARD_LIMIT = 1000;

const inputSchema = {
	query: z.string().min(1).describe('SPARQL query. SELECT returns rows; ASK returns a boolean.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.optional()
		.describe(
			`Maximum rows to return. Caps what is handed back, not what the query service computes — add LIMIT to the query itself to spare it the work. Hard cap ${HARD_LIMIT}, which also applies when omitted.`,
		),
} as const;

export const wikibaseQuery: Tool<typeof inputSchema> = {
	name: 'wikibase-query',
	description: `Runs a SPARQL query against the targeted wiki's query service and returns the solutions as rows, one line per solution with the cells joined by \` | \` in column order; a line break inside a cell becomes a space, and a cell containing that separator is not escaped. Enabled only when the wiki is a Wikibase repository with a query service configured.\n\nThe answer to a question about many entities at once, or about which entities have a given statement — for one known entity, wikibase-get-entity is a single request. Property and entity IDs are wiki-specific and the prefixes are too (Wikidata's \`wd:\`/\`wdt:\` are not universal), so ground both with wikibase-search-entities first.\n\nExample against a Wikidata-style prefix scheme:\n  SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 } LIMIT 10\n\nA malformed query returns the query service's own parser message. Long-running queries are cut off after 60 seconds. Up to ${HARD_LIMIT} rows per call, and the response body is truncated at 50000 bytes by default; add LIMIT and OFFSET to the query to page beyond that.`,
	inputSchema,
	annotations: {
		title: 'Run SPARQL query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'run SPARQL query',
	target: (a) => a.query,

	async handle({ query, limit }, ctx: ToolContext): Promise<CallToolResult> {
		// A wiki with no endpoint never reaches here: the pack's wikiGate is what
		// refuses it, centrally, for every gated tool.
		const { config } = ctx.activeWiki.get();
		const endpoint = (config.sparqlEndpoint ?? '').trim();

		const effectiveLimit = limit ?? HARD_LIMIT;
		let results;
		try {
			results = await runSparqlQuery(endpoint, query, effectiveLimit);
		} catch (err) {
			if (err instanceof SparqlError) {
				return ctx.format.error(err.category, err.message);
			}
			throw err;
		}

		if (results.boolean !== undefined) {
			return ctx.format.ok({ boolean: results.boolean });
		}

		const byteCapped = capLinesByBytes(results.rows);

		return ctx.format.ok({
			columns: results.columns,
			rows: byteCapped.lines,
			...truncationOf(byteCapped, results.totalRows, effectiveLimit),
		});
	},
};

function truncationOf(
	capped: { lines: string[]; returnedBytes: number; totalBytes: number; truncated: boolean },
	totalRows: number,
	limit: number,
): { truncation?: TruncationInfo } {
	if (capped.truncated) {
		return {
			truncation: {
				reason: 'content-truncated',
				returnedBytes: capped.returnedBytes,
				totalBytes: capped.totalBytes,
				itemNoun: 'rows',
				toolName: 'wikibase-query',
				// A byte-truncated response that also hit the row cap leaves a caller
				// told only about the bytes believing the rest is one page away.
				remedyHint:
					totalRows > limit
						? `To read the rest of the ${totalRows} rows the query matched (${capped.lines.length} delivered before the byte cap), narrow the projection or page with LIMIT and OFFSET.`
						: 'To read the rest, narrow the projection or page with LIMIT and OFFSET.',
			},
		};
	}
	if (totalRows > limit) {
		return {
			truncation: {
				reason: 'capped-no-continuation',
				returnedCount: limit,
				limit,
				itemNoun: 'rows',
				narrowHint: `the query matched ${totalRows} — page through them with LIMIT and OFFSET in the query.`,
			},
		};
	}
	return {};
}
