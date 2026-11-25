import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import {
	SPARQL_ROW_CAP,
	sparqlLimitSchema,
	sparqlToolResult,
} from '../../../results/sparqlResults.ts';
import { runSparqlQuery } from './sparql.ts';
import { resolveSiteInfo } from '../../../wikis/siteInfo.ts';

const inputSchema = {
	query: z.string().min(1).describe('SPARQL query. SELECT returns rows; ASK returns a boolean.'),
	limit: sparqlLimitSchema('the query service'),
} as const;

export const wikibaseQuery: Tool<typeof inputSchema> = {
	name: 'wikibase-query',
	description: `Runs a SPARQL query against the targeted wiki's query service and returns the solutions as rows, one line per solution with the cells joined by \` | \` in column order; a line break inside a cell becomes a space, and a cell containing that separator is not escaped. Enabled only when the wiki is a Wikibase repository that publishes a query service.\n\nThe answer to a question about many entities at once, or about which entities have a given statement — for one known entity, wikibase-get-entity is a single request. Property and entity IDs are wiki-specific and the prefixes are too (Wikidata's \`wd:\`/\`wdt:\` are not universal), so ground both with wikibase-search-entities first.\n\nExample against a Wikidata-style prefix scheme:\n  SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 } LIMIT 10\n\nA malformed query returns the query service's own parser message. Long-running queries are cut off after 60 seconds. Up to ${SPARQL_ROW_CAP} rows per call, and the response body is truncated at 75000 bytes by default; add LIMIT and OFFSET to the query to page beyond that.`,
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
		// The pack's wikiGate has refused a wiki that publishes none before dispatch.
		const endpoint = ((await resolveSiteInfo(ctx, ctx.wiki.key)).sparqlEndpoint ?? '').trim();
		const effectiveLimit = limit ?? SPARQL_ROW_CAP;
		const results = await runSparqlQuery(endpoint, query, effectiveLimit);

		return ctx.format.ok(sparqlToolResult(results, effectiveLimit, 'wikibase-query'));
	},
};
