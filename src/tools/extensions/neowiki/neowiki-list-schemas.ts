import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import type { TruncationInfo } from '../../../results/truncation.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

// The /schemas endpoint caps `limit` at 50 (rejects higher with a 400).
// Paginate beyond that via the offset carried in continueFrom.
const PAGE_LIMIT = 50;

const inputSchema = {
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque offset token from a previous response; omit on first call.'),
} as const;

interface SchemaSummary {
	name?: string;
	description?: string;
	propertyCount?: number;
}

interface ListSchemasResponse {
	schemas?: SchemaSummary[];
	totalRows?: number;
}

export const neowikiListSchemas: Tool<typeof inputSchema> = {
	name: 'neowiki-list-schemas',
	description:
		"Lists the Schemas (entity types, e.g. Person, Company) defined in the wiki's NeoWiki knowledge graph, each with its description and property count. Enabled only when the wiki has NeoWiki installed. Start here to discover what types exist, then use neowiki-get-schema for one type's properties, or neowiki-cypher-query to query the graph. Paginate with continueFrom. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'List NeoWiki schemas',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'list NeoWiki schemas',

	async handle({ continueFrom }, ctx: ToolContext): Promise<CallToolResult> {
		let offset = 0;
		if (continueFrom !== undefined) {
			const parsed = Number.parseInt(continueFrom, 10);
			if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== continueFrom) {
				return ctx.format.invalidInput('continueFrom must be a non-negative integer');
			}
			offset = parsed;
		}

		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /schemas response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: '/schemas',
				query: { limit: String(PAGE_LIMIT), offset: String(offset) },
			})) as ListSchemasResponse;

			const schemas = Array.isArray(data.schemas) ? data.schemas : [];
			const totalRows = typeof data.totalRows === 'number' ? data.totalRows : schemas.length;

			// Require a non-empty page before advancing: a degenerate response
			// (0 rows but totalRows still > offset) must not hand back a token
			// that never advances, which would loop a paginating client forever.
			const truncation: TruncationInfo | null =
				schemas.length > 0 && offset + schemas.length < totalRows
					? {
							reason: 'more-available',
							returnedCount: schemas.length,
							itemNoun: 'schemas',
							toolName: 'neowiki-list-schemas',
							continueWith: { param: 'continueFrom', value: String(offset + schemas.length) },
						}
					: null;

			return ctx.format.ok({ schemas, ...(truncation !== null ? { truncation } : {}) });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
