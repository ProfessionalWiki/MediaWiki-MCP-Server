import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import type { TruncationInfo } from '../../../results/truncation.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const inputSchema = {
	cypher: z
		.string()
		.min(1)
		.describe(
			'A single read-only Cypher statement. Backtick-escape property names with spaces (`s.`Birth year``). Do NOT RETURN whole nodes — project scalar properties and cast temporals with toString().',
		),
	parameters: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Parameter map referenced as $name in the query. Prefer this over string concatenation.',
		),
} as const;

interface CypherResponse {
	columns?: unknown[];
	rows?: unknown[];
	resultCount?: number;
	durationMs?: number;
	truncated?: boolean;
}

export const neowikiCypherQuery: Tool<typeof inputSchema> = {
	name: 'neowiki-cypher-query',
	description:
		'Runs a read-only Cypher query against the wiki\'s NeoWiki knowledge graph (Neo4j) and returns rows. Enabled only when the wiki has NeoWiki installed.\n\nDiscover the data model first — the graph CANNOT be introspected from Cypher (CALL db.labels(), db.schema.* and all procedure calls are rejected as not-read-only). Use neowiki-list-schemas for the entity types, then neowiki-get-schema for a type\'s properties and relations.\n\nGraph model:\n- Subjects are nodes labelled `:Subject` plus a per-schema label, e.g. (s:Subject:Person). Subject node properties are the schema\'s properties plus `id` and `name`; backtick-escape names with spaces: s.`Birth year`.\n- Pages are (:Page) nodes linked by (:Page)-[:HasSubject]->(:Subject). Subject-to-subject relations are typed edges named in the schema\'s `relation` field (see neowiki-get-schema).\n- `select` values are stored as opaque option IDs (e.g. o1abc…), not labels — decode them with neowiki-get-schema.\n\nGotchas:\n- Do NOT RETURN whole nodes: a node carrying a temporal property fails the request. Return specific scalar properties and cast temporals: toString(s.creationTime).\n- Plain list values (labels(n), collect(...)) come back as 1-indexed JSON objects ({"1":…,"2":…}), not arrays.\n- Read-only only; write clauses are rejected.\n\nLimits: ~5,000 rows / 30s by default (50,000 / 300s with the apihighlimits right). When `truncated` is true, narrow with WHERE or add LIMIT/SKIP. Pre-1.0: the NeoWiki API may change without notice.\n\nExample:\n  cypher: MATCH (s:Subject:Person) WHERE s.`Birth year` > $minYear RETURN s.name AS name, s.`Birth year` AS year ORDER BY year\n  parameters: { "minYear": 2000 }',
	inputSchema,
	annotations: {
		title: 'Run NeoWiki Cypher query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'run NeoWiki Cypher query',
	target: (a) => a.cypher,

	async handle({ cypher, parameters }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /query/cypher response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'POST',
				path: '/query/cypher',
				body: { cypher, ...(parameters !== undefined ? { parameters } : {}) },
			})) as CypherResponse;

			const columns = Array.isArray(data.columns) ? data.columns : [];
			const rows = Array.isArray(data.rows) ? data.rows : [];
			const truncation: TruncationInfo | null =
				data.truncated === true
					? {
							reason: 'capped-no-continuation',
							returnedCount: rows.length,
							limit: rows.length,
							itemNoun: 'rows',
							narrowHint:
								'narrow with WHERE, add LIMIT/SKIP to paginate, or use an account with the apihighlimits right for a higher cap.',
						}
					: null;

			return ctx.format.ok({
				columns,
				rows,
				resultCount: typeof data.resultCount === 'number' ? data.resultCount : rows.length,
				...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
				...(truncation !== null ? { truncation } : {}),
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
