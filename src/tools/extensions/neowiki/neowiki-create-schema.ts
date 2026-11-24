import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { formatEditComment } from '../../../wikis/utils.ts';
import { presentSchema, readSchema, saveSchema, schemaInputSchema } from './schemas.ts';

const inputSchema = schemaInputSchema;

export const neowikiCreateSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-create-schema',
	description:
		'Creates a NeoWiki Schema, the type a Subject follows, and returns it as saved, in the shape neowiki-get-schema returns. Enabled only when the wiki has NeoWiki installed. Refuses a name that already has a Schema; change one with neowiki-update-schema. A Schema is a page in the Schema namespace, so this requires the rights to create a page there, which logged-in users have by default; subjectsAreControlled also needs the neowiki-controlled-subject-edit right. An invalid Schema, such as a relation without targetSchemas or two property names that differ only in case or spacing, is refused with the reason.',
	inputSchema,
	annotations: {
		title: 'Create NeoWiki schema',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'create NeoWiki schema',
	target: (a) => a.name,

	async handle({ name, comment, ...schema }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		if ((await readSchema(mwn, name)) !== null) {
			return ctx.format.conflict(
				`NeoWiki schema "${name}" already exists; change it with neowiki-update-schema.`,
			);
		}

		const editComment = formatEditComment(ctx, 'neowiki-create-schema', comment);
		const saved = await saveSchema(mwn, name, schema, editComment);

		return ctx.format.ok({ status: 'created', ...presentSchema(name, saved) });
	},
};
