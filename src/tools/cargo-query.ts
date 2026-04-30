import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

const HARD_LIMIT = 500;

const inputSchema = {
	tables: z
		.string()
		.min(1)
		.describe(
			'Comma-separated Cargo table names to query. Use cargo-list-tables to discover available tables.',
		),
	fields: z
		.string()
		.optional()
		.describe(
			'Comma-separated fields to return, with optional aliases (e.g. `name,drop_level` or `name=Item Name`). Omit to return all fields.',
		),
	where: z
		.string()
		.optional()
		.describe(
			'SQL WHERE clause fragment (without the WHERE keyword). Use HOLDS / HOLDS LIKE for list fields, MATCHES for Searchtext, NEAR for Coordinates.',
		),
	joinOn: z
		.string()
		.optional()
		.describe('JOIN ON clause for multi-table queries (e.g. `items._pageName=drops._pageName`).'),
	groupBy: z.string().optional().describe('SQL GROUP BY clause fragment.'),
	having: z.string().optional().describe('SQL HAVING clause fragment (requires groupBy).'),
	orderBy: z.string().optional().describe('SQL ORDER BY clause fragment (e.g. `drop_level DESC`).'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.optional()
		.describe('Maximum rows to return. Hard cap 500. Defaults to 500 when omitted.'),
	continueFrom: z
		.string()
		.optional()
		.describe('Pagination token from a prior response (non-negative integer offset).'),
} as const;

interface CargoEntry {
	title?: Record<string, unknown>;
}

interface CargoQueryResponse {
	cargoquery?: CargoEntry[];
}

export const cargoQuery: Tool<typeof inputSchema> = {
	name: 'cargo-query',
	description:
		'Queries a Cargo database table on the active wiki and returns matching rows. Supports WHERE, JOIN ON, GROUP BY, HAVING, and ORDER BY clauses using SQL syntax. Use cargo-list-tables to discover table names and cargo-describe-table to inspect field types before constructing a query — field types determine which operators apply (HOLDS / HOLDS LIKE for list fields, MATCHES for Searchtext, NEAR for Coordinates). Up to 500 rows per call; paginate with continueFrom.',
	inputSchema,
	annotations: {
		title: 'Run Cargo query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'run Cargo query',
	target: (a) => a.tables,

	async handle(
		{ tables, fields, where, joinOn, groupBy, having, orderBy, limit, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		let currentOffset = 0;
		if (continueFrom !== undefined) {
			const parsed = Number.parseInt(continueFrom, 10);
			if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== continueFrom) {
				return ctx.format.invalidInput('continueFrom must be a non-negative integer');
			}
			currentOffset = parsed;
		}

		const effectiveLimit = limit ?? HARD_LIMIT;

		const params: Record<string, unknown> = {
			action: 'cargoquery',
			tables,
			limit: effectiveLimit,
			format: 'json',
		};

		if (fields !== undefined) params.fields = fields;
		if (where !== undefined) params.where = where;
		if (joinOn !== undefined) params.join_on = joinOn;
		if (groupBy !== undefined) params.group_by = groupBy;
		if (having !== undefined) params.having = having;
		if (orderBy !== undefined) params.order_by = orderBy;
		if (continueFrom !== undefined) params.offset = currentOffset;

		const mwn = await ctx.mwn();
		const raw = await mwn.request(params);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cargo action=cargoquery response shape; trusted at this boundary
		const response = raw as CargoQueryResponse;

		const entries = response.cargoquery ?? [];
		// The `title` key is a static MediaWiki XML-tagging artifact, not a page
		// title. Unwrap each entry.title to surface the actual field values.
		const rows = entries.map((entry) => entry.title ?? {});

		// `>=` rather than `===` — defensive against future Cargo versions that
		// return more rows than the requested limit.
		const truncation: TruncationInfo | null =
			rows.length >= effectiveLimit
				? {
						reason: 'more-available',
						returnedCount: rows.length,
						itemNoun: 'rows',
						toolName: 'cargo-query',
						continueWith: {
							param: 'continueFrom',
							value: String(currentOffset + rows.length),
						},
					}
				: null;

		return ctx.format.ok({
			rows,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
