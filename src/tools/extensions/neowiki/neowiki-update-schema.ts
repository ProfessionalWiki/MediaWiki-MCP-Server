import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import {
	PROPERTY_ATTRIBUTES,
	duplicatePropertyName,
	presentSchema,
	readSchema,
	saveSchema,
	schemaInputSchema,
	toSchemaJson,
} from './schemas.ts';

const inputSchema = {
	...schemaInputSchema,
	subjectsAreDependent: schemaInputSchema.subjectsAreDependent.describe(
		'As the Schema has it: true for a Schema of Dependent Subjects, omitted otherwise. It cannot change after the Schema is created.',
	),
	properties: schemaInputSchema.properties.describe(
		`Every property the Schema keeps, each { name, type, … } as neowiki-get-schema returns it; a property left out is removed. ${PROPERTY_ATTRIBUTES}`,
	),
} as const;

export const neowikiUpdateSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-update-schema',
	description:
		"Replaces a NeoWiki Schema's description, labels, flags and properties — a FULL replace: a property left out is removed, and an omitted description, labels or flag is cleared, so pass the whole Schema as neowiki-get-schema returns it, changed where needed. Returns the Schema as saved, in that shape. Enabled only when the wiki has NeoWiki installed. The write does not check for changes made since the Schema was read: read it with neowiki-get-schema just before. Refuses a name without a Schema; create one with neowiki-create-schema. Subjects keep their Statements whatever the Schema says: removing or renaming a property leaves its Statements under the old name, and changing a type or constraint can put existing values in violation. Requires the rights to edit a page in the Schema namespace, which logged-in users have by default; turning subjectsAreControlled on or off also needs the neowiki-controlled-subject-edit right. An invalid Schema is refused with the reason.",
	inputSchema,
	annotations: {
		title: 'Update NeoWiki schema',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'update NeoWiki schema',
	target: (a) => a.name,

	async handle({ name, comment, ...schema }, ctx: ToolContext): Promise<CallToolResult> {
		const duplicate = duplicatePropertyName(schema.properties);
		if (duplicate !== undefined) {
			return ctx.format.invalidInput(`Property "${duplicate}" is listed more than once.`);
		}

		const mwn = await ctx.mwn();
		if ((await readSchema(mwn, name)) === null) {
			return ctx.format.notFound(
				`NeoWiki schema "${name}" not found; create it with neowiki-create-schema.`,
			);
		}

		const editComment = formatEditComment(ctx, 'neowiki-update-schema', comment);
		const saved = await saveSchema(mwn, name, toSchemaJson(schema), editComment);

		return ctx.format.ok({ status: 'updated', ...presentSchema(name, saved) });
	},
};
