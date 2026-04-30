import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

const HARD_LIMIT = 500;

const inputSchema = {
	query: z
		.string()
		.describe(
			'Bucket Lua chain ending in `.run()`. ' +
				'Example: bucket("drops").select("page_name","item").where("item","Bandos chestplate").run()',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.optional()
		.describe('Appended as `.limit(N)` immediately before `.run()`. Hard cap 500.'),
	continueFrom: z
		.string()
		.optional()
		.describe(
			'Continuation token from a prior response (a non-negative integer offset); appended as `.offset(N)` before `.run()`.',
		),
} as const;

interface BucketResponse {
	bucketQuery?: string;
	bucket?: unknown;
	error?: string;
}

export const bucketQuery: Tool<typeof inputSchema> = {
	name: 'bucket-query',
	description:
		'Runs a Bucket extension query against the active wiki. Pass a fully built Lua chain ending in `.run()`; the server caps results at 500 rows per call and paginates via `continueFrom`.\n\nGround bucket and field names BEFORE composing a query — guessing fails. Schemas live as JSON pages in the `Bucket:` namespace (id 9592). The bucket name passed to `bucket(...)` is the page title with the `Bucket:` prefix stripped, lowercased, and spaces replaced with underscores. Examples: page `Bucket:Exchange` → `bucket("exchange")`; page `Bucket:Combat achievement` → `bucket("combat_achievement")`; page `Bucket:Infobox item` → `bucket("infobox_item")`.\n\nDiscovery flow: call `search-page-by-prefix` with `namespace=9592` and a starting-letter `prefix` you suspect a relevant bucket starts with (e.g. `prefix="E"` for Grand Exchange / item price data → `Bucket:Exchange`; `prefix="C"` for combat achievements → `Bucket:Combat achievement`; `prefix="I"` for infobox-style data → `Bucket:Infobox item`). Then `get-page` on the matching `Bucket:<Name>` to read the JSON schema — each top-level key is a field with a `type` of PAGE, TEXT, INTEGER, DOUBLE, or BOOLEAN. Field names are already lowercase-underscored in the schema; pass them verbatim.\n\nQuery syntax (full reference: https://meta.weirdgloop.org/w/Extension:Bucket/Usage):\n- `select("a","b",...)` — fields to return.\n- `where({"field","value"})` or shorthand `where("field","value")` for equality. For comparators use the table form with an operator: `where({"value",">",1000000})`. Operators: `=`, `!=`, `>`, `<`, `>=`, `<=`. Compose with `Bucket.And(c1,c2)`, `Bucket.Or(c1,c2)`, `Bucket.Not(c)`.\n- `orderBy("field","asc")` or `"desc"`.\n- `.run()` returns an array of row tables; an empty array means no matches.\n\nFull example: `bucket("exchange").select("name","value","high_alch").where("name","Abyssal whip").run()`. Bucket\'s third-party API is not yet stable upstream, so error wording from the wiki may shift between versions.',
	inputSchema,
	annotations: {
		title: 'Run Bucket query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'run Bucket query',
	target: (a) => a.query,

	async handle({ query, limit, continueFrom }, ctx: ToolContext): Promise<CallToolResult> {
		const rendered = renderQuery(query, limit, continueFrom);
		if (rendered.kind === 'error') {
			return ctx.format.invalidInput(rendered.message);
		}

		const mwn = await ctx.mwn();
		// Bucket returns errors as `{error: <string>}` at the top level. mwn's
		// `request()` checks for a top-level `error` field and throws MwnError, but
		// Bucket's string shape doesn't match the standard `{code, info}` object
		// MwnError expects, so the resulting message is empty. `rawRequest` skips
		// that processing — but it also skips mwn's `applyAuthentication`, so we
		// inject the OAuth2 bearer header ourselves. BotPassword cookies still
		// flow via mwn's axios interceptor.
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};
		if (mwn.usingOAuth2 && typeof mwn.options.OAuth2AccessToken === 'string') {
			headers.Authorization = `Bearer ${mwn.options.OAuth2AccessToken}`;
		}
		const axiosResponse = await mwn.rawRequest({
			url: mwn.options.apiUrl,
			method: 'POST',
			data: new URLSearchParams({
				action: 'bucket',
				query: rendered.query,
				format: 'json',
			}).toString(),
			headers,
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bucket action=bucket response shape; trusted at this boundary
		const response = axiosResponse.data as BucketResponse;

		if (typeof response.error === 'string' && response.error !== '') {
			return ctx.format.invalidInput(response.error);
		}

		const rows = extractRows(response.bucket, ctx);
		const effectiveLimit = Math.min(limit ?? HARD_LIMIT, HARD_LIMIT);
		const currentOffset = continueFrom !== undefined ? Number.parseInt(continueFrom, 10) : 0;

		// `>=` rather than `===` — defensive against a Bucket version that
		// returns more rows than the injected `.limit()` requested.
		const truncation: TruncationInfo | null =
			rows.length >= effectiveLimit
				? {
						reason: 'more-available',
						returnedCount: rows.length,
						itemNoun: 'rows',
						toolName: 'bucket-query',
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

type RenderResult = { kind: 'ok'; query: string } | { kind: 'error'; message: string };

// Locates the trailing `.run()` (whitespace tolerant) and inserts
// `.limit(N).offset(M)` immediately before it. Last-wins semantics in
// BucketQuery's options-table constructor mean any earlier `.limit(M)` in
// the user chain is overridden by ours.
const RUN_AT_END = /\.\s*run\s*\(\s*\)\s*$/;

function renderQuery(
	rawQuery: string,
	schemaLimit: number | undefined,
	continueFrom: string | undefined,
): RenderResult {
	const trimmed = rawQuery.replace(/\s+$/, '');
	const match = trimmed.match(RUN_AT_END);
	if (!match) {
		return { kind: 'error', message: 'query must end in .run()' };
	}

	const effectiveLimit = Math.min(schemaLimit ?? HARD_LIMIT, HARD_LIMIT);
	let offsetSuffix = '';
	if (continueFrom !== undefined) {
		const parsed = Number.parseInt(continueFrom, 10);
		if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== continueFrom) {
			return { kind: 'error', message: 'continueFrom must be a non-negative integer' };
		}
		offsetSuffix = `.offset(${parsed})`;
	}

	const head = trimmed.slice(0, match.index);
	return {
		kind: 'ok',
		query: `${head}.limit(${effectiveLimit})${offsetSuffix}.run()`,
	};
}

function extractRows(value: unknown, ctx: ToolContext): unknown[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (Array.isArray(value)) {
		return value;
	}
	ctx.logger.debug('bucket-query: non-array bucket field, wrapping as single row', {
		valueType: typeof value,
	});
	return [value];
}
