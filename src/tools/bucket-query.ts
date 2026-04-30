import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';

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

	async handle({ query }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const raw = await mwn.request({
			action: 'bucket',
			query,
			format: 'json',
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bucket action=bucket response shape; trusted at this boundary
		const response = raw as BucketResponse;

		if (typeof response.error === 'string' && response.error !== '') {
			return ctx.format.invalidInput(response.error);
		}

		const rows = Array.isArray(response.bucket) ? response.bucket : [];
		return ctx.format.ok({ rows });
	},
};
