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
			'Opaque continuation token from a prior response; appended as `.offset(N)` before `.run()`.',
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
		'Runs a Bucket extension query against the active wiki. Pass a fully built Lua chain ending in `.run()`; the server caps results at 500 rows per call and paginates via `continueFrom`. Bucket\'s third-party API is not yet stable upstream, so error wording from the wiki may shift between versions.\n\nExample:\n- bucket("drops").select("page_name","item","quantity").where("item","Rune scimitar").run()',
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
		// that processing while still applying mwn's auth (cookies / OAuth).
		const axiosResponse = await mwn.rawRequest({
			url: mwn.options.apiUrl,
			method: 'POST',
			data: new URLSearchParams({
				action: 'bucket',
				query: rendered.query,
				format: 'json',
			}).toString(),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bucket action=bucket response shape; trusted at this boundary
		const response = axiosResponse.data as BucketResponse;

		if (typeof response.error === 'string' && response.error !== '') {
			return ctx.format.invalidInput(response.error);
		}

		const rows = extractRows(response.bucket, ctx);
		const effectiveLimit = Math.min(limit ?? HARD_LIMIT, HARD_LIMIT);
		const currentOffset = continueFrom !== undefined ? Number.parseInt(continueFrom, 10) : 0;

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
