import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';

const inputSchema = {
	name: z.string().min(1).describe('Schema name. Use neowiki-list-schemas to discover names.'),
} as const;

interface GetSchemaResponse {
	schema?: {
		description?: string;
		subjectsAreDependent?: boolean;
		propertyDefinitions?: Record<string, Record<string, unknown>>;
	};
}

export const neowikiGetSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-get-schema',
	description:
		"Returns one NeoWiki Schema's property definitions: each property's name, type (text/number/boolean/url/date/dateTime/select/relation/monolingualText), and type-specific attributes. Enabled only when the wiki has NeoWiki installed. A `relation` property's name is its graph edge type, and `targetSchemas` lists the Schemas its targets follow — this is the relationship vocabulary for neowiki-cypher-query. `select` properties carry `options`, the list of { id, label } needed to decode select values returned by queries. A constraint (`required`, `minimum`, `options`, …) is a bare value, or an object carrying its severity: { value, severity }, or { severity } for a boolean constraint that is true; it only warns unless its severity is `error` and the wiki enforces validation. `subjectsAreDependent: true` marks a Schema whose Subjects are Dependent Subjects: unlabelled, never a page's Main Subject, each reached through one relation from its Host Subject on the same page. Use neowiki-list-schemas to discover schema names. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Get NeoWiki schema',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
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
				...(data.schema.subjectsAreDependent === true ? { subjectsAreDependent: true } : {}),
				properties,
			});
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
