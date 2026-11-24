import { z } from 'zod';
import type { Mwn } from 'mwn';
import { neowikiRequest } from './neowikiRequest.ts';

/** A Schema as NeoWiki stores and serves it. */
export interface SchemaJson {
	description?: string;
	labels?: Record<string, string>;
	subjectsAreDependent?: boolean;
	subjectsAreControlled?: boolean;
	propertyDefinitions?: Record<string, Record<string, unknown>>;
}

interface SchemaResponse {
	schema?: SchemaJson | null;
}

/** Null where the Schema does not exist or the caller may not read it. */
export async function readSchema(mwn: Mwn, name: string): Promise<SchemaJson | null> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /schema response shape; trusted at this boundary
	const data = (await neowikiRequest(mwn, {
		method: 'GET',
		path: `/schema/${encodeURIComponent(name)}`,
	})) as SchemaResponse;
	return data.schema ?? null;
}

export async function saveSchema(
	mwn: Mwn,
	name: string,
	schema: SchemaJson,
	comment: string | undefined,
): Promise<SchemaJson> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /schema response shape; trusted at this boundary
	const data = (await neowikiRequest(mwn, {
		method: 'PUT',
		path: `/schema/${encodeURIComponent(name)}`,
		csrf: true,
		body: { schema, ...(comment !== undefined ? { comment } : {}) },
	})) as SchemaResponse;
	return data.schema ?? schema;
}

/** The shape neowiki-get-schema returns and the Schema write tools take: NeoWiki's, with the name. */
export function presentSchema(
	name: string,
	schema: SchemaJson,
): SchemaJson & { name: string; description: string } {
	return {
		name,
		description: schema.description ?? '',
		...(schema.labels !== undefined ? { labels: schema.labels } : {}),
		...(schema.subjectsAreDependent === true ? { subjectsAreDependent: true } : {}),
		...(schema.subjectsAreControlled === true ? { subjectsAreControlled: true } : {}),
		propertyDefinitions: schema.propertyDefinitions ?? {},
	};
}

export const PROPERTY_ATTRIBUTES =
	'Besides type, every definition takes description, labels (by language tag), required and default; and by type: multiple (text, monolingualText, url, select, relation), uniqueItems (text, url; with multiple), uniqueLanguages (monolingualText; with multiple), minLength and maxLength (text, monolingualText), minimum and maximum (number; date and dateTime as ISO 8601 strings), precision (number: decimal places shown), options (select: [{ id, label }], each id unique within the property and kept when its label changes, since Statements hold ids) and targetSchemas (relation, required: the names of the Schemas a target may follow). A constraint is a bare value, which only warns, or { value, severity } with severity error or warning; a boolean constraint set to true is { severity }.';

const propertyDefinitionSchema = z
	.object({
		type: z
			.string()
			.min(1)
			.describe(
				'Property type: text, monolingualText, url, number, select, relation, boolean, date or dateTime.',
			),
	})
	.catchall(z.unknown());

export const schemaInputSchema = {
	name: z
		.string()
		.min(1)
		.describe(
			'Schema name: the title of its page in the Schema namespace, without the prefix, such as Person.',
		),
	description: z.string().optional().describe('What the Schema is for.'),
	labels: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'What the UI calls the Schema, by language tag, such as { "de": "Unternehmen" }; everything else uses its name.',
		),
	subjectsAreDependent: z
		.boolean()
		.optional()
		.describe(
			'True for a Schema of Dependent Subjects: unlabelled, each reached through one relation from its Host Subject on the same page. Set when the Schema is created; it cannot change later, nor be true with subjectsAreControlled.',
		),
	subjectsAreControlled: z
		.boolean()
		.optional()
		.describe(
			'True for a Schema of Controlled Subjects, a controlled vocabulary that only holders of the neowiki-controlled-subject-edit right can change.',
		),
	propertyDefinitions: z
		.record(z.string(), propertyDefinitionSchema)
		.describe(
			`The Schema's properties, as neowiki-get-schema returns them: a map of property name, the key its Statements are stored under, to its definition. ${PROPERTY_ATTRIBUTES}`,
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;
