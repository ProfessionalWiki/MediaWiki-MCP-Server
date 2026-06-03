import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const inputSchema = {
	name: z.string().min(1).describe('Schema name. Use neowiki-list-schemas to discover names.'),
} as const;

interface GetSchemaResponse {
	schema?: {
		description?: string;
		propertyDefinitions?: Record<string, Record<string, unknown>>;
	};
}

export const neowikiGetSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-get-schema',
	description:
		"Returns one NeoWiki Schema's property definitions: each property's name, type (text/number/boolean/url/date/datetime/select/relation), and type-specific attributes. Enabled only when the wiki has NeoWiki installed. `relation` properties name the graph edge (`relation`) and the `targetSchema` they point to — this is the relationship vocabulary for neowiki-cypher-query. `select` properties carry the option ID->label map needed to decode select values returned by queries. Use neowiki-list-schemas to discover schema names. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Get NeoWiki schema',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'get NeoWiki schema',
	target: (a) => a.name,

	async handle({ name }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /schema response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: `/schema/${encodeURIComponent(name)}`,
			})) as GetSchemaResponse;

			if (data.schema === undefined || data.schema === null) {
				return ctx.format.notFound(`NeoWiki schema "${name}" not found`);
			}

			const definitions = data.schema.propertyDefinitions ?? {};
			const properties = Object.entries(definitions).map(([propName, def]) => ({
				name: propName,
				...def,
			}));

			return ctx.format.ok({
				name,
				description: data.schema.description ?? '',
				properties,
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
