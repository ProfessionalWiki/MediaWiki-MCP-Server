import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { capRowsByBytes } from '../../../results/truncation.ts';
import { cargoRefusal } from './cargoRefusal.ts';
import {
	MALFORMED_CONTINUE_FROM,
	offsetFrom,
	rowPageTruncation,
} from '../../../results/offsetCursor.ts';

const QUERY_HINT =
	'Verify table and field names with cargo-list-tables / cargo-describe-table, or inspect Special:CargoTables.';

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
		"Returns rows from one or more Cargo tables on the targeted wiki, matching a SQL-style filter. Supports WHERE, JOIN ON, GROUP BY, HAVING, and ORDER BY clauses. Enabled only when the wiki has Cargo installed. Use cargo-list-tables to discover table names and cargo-describe-table to inspect field types before constructing a query — field types determine which operators apply (HOLDS / HOLDS LIKE for list fields, MATCHES for Searchtext, NEAR for Coordinates). Cargo collapses NULL to empty string on output, so `where=field=''` matches both unset and truly-empty values. Up to 500 rows per call, and only the whole rows that fit in 75000 bytes by default; paginate with continueFrom.",
	inputSchema,
	annotations: {
		title: 'Run Cargo query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'run Cargo query',
	tailoredErrors: {
		internal_api_error_MWException: () => ({
			category: 'invalid_input',
			message: `Cargo could not parse the query. ${QUERY_HINT}`,
		}),
		db_error: (message) => {
			const reason = cargoRefusal(message);
			return reason === undefined
				? undefined
				: {
						category: 'invalid_input',
						message: `Cargo refused the query: ${reason} ${QUERY_HINT}`,
					};
		},
	},
	target: (a) => a.tables,

	async handle(
		{ tables, fields, where, joinOn, groupBy, having, orderBy, limit, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const currentOffset = offsetFrom(continueFrom);
		if (currentOffset === undefined) {
			return ctx.format.invalidInput(MALFORMED_CONTINUE_FROM);
		}

		const effectiveLimit = limit ?? HARD_LIMIT;

		const params: Record<string, string | number | boolean> = {
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
		const capped = capRowsByBytes(rows);

		return ctx.format.ok({
			rows: capped.rows,
			...rowPageTruncation(capped, {
				toolName: 'cargo-query',
				offset: currentOffset,
				// `>=` in case a Cargo version returns more rows than the limit asked for.
				nextOffset: rows.length >= effectiveLimit ? currentOffset + rows.length : undefined,
				narrowing: 'name fewer fields in fields',
			}),
		});
	},
};
