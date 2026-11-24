import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { presentSchema, readSchema } from './schemas.ts';

const inputSchema = {
	name: z.string().min(1).describe('Schema name. Use neowiki-list-schemas to discover names.'),
} as const;

export const neowikiGetSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-get-schema',
	description:
		"Returns one NeoWiki Schema in NeoWiki's Schema format, which neowiki-create-schema and neowiki-update-schema take back: its description, labels and flags, and propertyDefinitions, a map of each property's name to its type (text/number/boolean/url/date/dateTime/select/relation/monolingualText) and type-specific attributes. Enabled only when the wiki has NeoWiki installed. A `relation` property's name is its graph edge type, and `targetSchemas` lists the Schemas its targets follow — this is the relationship vocabulary for neowiki-cypher-query. `select` properties carry `options`, the list of { id, label } needed to decode select values returned by queries. A constraint (`required`, `minimum`, `options`, …) is a bare value, or an object carrying its severity: { value, severity }, or { severity } for a boolean constraint that is true; it only warns unless its severity is `error` and the wiki enforces validation. `subjectsAreDependent: true` marks a Schema whose Subjects are Dependent Subjects: unlabelled, never a page's Main Subject, each reached through one relation from its Host Subject on the same page. `subjectsAreControlled: true` marks a Schema whose Subjects are Controlled Subjects, a controlled vocabulary: changing them needs the neowiki-controlled-subject-edit right, while any relation may still target them. `labels`, on the Schema and on a property, are what the UI calls it, by language tag; tools and queries take its name. Use neowiki-list-schemas to discover schema names.",
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
		const schema = await readSchema(await ctx.mwn(), name);
		if (schema === null) {
			return ctx.format.notFound(`NeoWiki schema "${name}" not found`);
		}

		return ctx.format.ok(presentSchema(name, schema));
	},
};
