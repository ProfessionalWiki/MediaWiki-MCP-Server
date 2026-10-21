import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';

// The /schemas endpoint caps `limit` at 50 (rejects higher with a 400).
const PAGE_LIMIT = 50;

const inputSchema = {
	continueFrom: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque cursor from a previous response; omit on first call.'),
} as const;

interface SchemaSummary {
	name?: string;
	description?: string;
	propertyCount?: number;
	subjectsAreDependent?: boolean;
}

interface ListSchemasResponse {
	schemas?: SchemaSummary[];
	nextCursor?: string | null;
}

export const neowikiListSchemas: Tool<typeof inputSchema> = {
	name: 'neowiki-list-schemas',
	description:
		"Lists the Schemas (entity types, e.g. Person, Company) defined in the wiki's NeoWiki knowledge graph, each with its description and property count; subjectsAreDependent is present, as true, only on a Schema whose Subjects are Dependent Subjects. Enabled only when the wiki has NeoWiki installed. Start here to discover what types exist, then use neowiki-get-schema for one type's properties, or neowiki-cypher-query to query the graph. Paginate with continueFrom. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'List NeoWiki schemas',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'list NeoWiki schemas',

	async handle({ continueFrom }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /schemas response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: '/schemas',
				query: {
					limit: String(PAGE_LIMIT),
					...(continueFrom !== undefined ? { cursor: continueFrom } : {}),
				},
			})) as ListSchemasResponse;

			const schemas = (Array.isArray(data.schemas) ? data.schemas : []).map(
				({ subjectsAreDependent, ...summary }) =>
					subjectsAreDependent === true ? { ...summary, subjectsAreDependent } : summary,
			);
			const truncation: TruncationInfo | null =
				typeof data.nextCursor === 'string'
					? {
							reason: 'more-available',
							returnedCount: schemas.length,
							itemNoun: 'schemas',
							toolName: 'neowiki-list-schemas',
							continueWith: { param: 'continueFrom', value: data.nextCursor },
						}
					: null;

			return ctx.format.ok({ schemas, ...(truncation !== null ? { truncation } : {}) });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
