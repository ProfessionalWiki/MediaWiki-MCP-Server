import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';

const inputSchema = {
	entityId: z
		.string()
		.regex(/^[A-Za-z]+\d+$/, 'Entity ID, such as Q42 or P31')
		.optional()
		.describe('The entity to write to. Omit to create a new one.'),
	entityType: z
		.enum(['item', 'property'])
		.default('item')
		.describe('Kind of entity to create. Ignored when entityId is set.'),
	data: z
		.record(z.string(), z.unknown())
		.describe(
			'The change, in Wikibase\'s entity JSON. Keys: labels, descriptions, aliases, claims, sitelinks. Terms are keyed by language code as {"en":{"language":"en","value":"Berlin"}}; claims is a list of statements.',
		),
	clear: z
		.boolean()
		.optional()
		.describe(
			'Removes everything the entity currently holds before applying data, instead of merging into it.',
		),
	comment: z.string().optional().describe('Edit summary, appended to the generated one.'),
} as const;

interface EditEntityResponse {
	entity?: { id?: string; type?: string; lastrevid?: number };
}

export const wikibaseEditEntity: Tool<typeof inputSchema> = {
	name: 'wikibase-edit-entity',
	description:
		'Creates or changes a Wikibase entity from a JSON description of the change, and returns the entity ID and new revision ID. Enabled only when the wiki is a Wikibase repository. Omit entityId to create a new entity, or name one to edit it. Requires the edit right.\n\ndata is merged into the entity: terms and statements it does not mention are left alone, and a term given for a language replaces that language\'s term. clear=true empties the entity first, so anything absent from data is deleted.\n\nExample data, setting an English label and adding one statement:\n{"labels":{"en":{"language":"en","value":"Berlin"}},"claims":[{"mainsnak":{"snaktype":"value","property":"P31","datavalue":{"type":"wikibase-entityid","value":{"entity-type":"item","id":"Q515"}}},"type":"statement","rank":"normal"}]}\n\nCreating a property requires datatype in data, which is fixed once the property exists, and sitelinks apply to items only. A statement\'s datavalue shape follows its property\'s datatype (read it with wikibase-get-entity on the property). For a single statement with an item, string, external-id or url value, wikibase-add-statement builds the JSON instead.',
	inputSchema,
	annotations: {
		title: 'Edit Wikibase entity',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'edit Wikibase entity',
	target: (a) => a.entityId ?? a.entityType,

	async handle(
		{ entityId, entityType, data, clear, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const params: Record<string, string | number | boolean> = {
			action: 'wbeditentity',
			...(entityId !== undefined ? { id: entityId.toUpperCase() } : { new: entityType }),
			data: JSON.stringify(data),
			...(clear === true ? { clear: true } : {}),
			...(comment !== undefined ? { summary: comment } : {}),
		};

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbeditentity response shape; trusted at this boundary
		const response = (await ctx.edit.submit(mwn, params)) as EditEntityResponse | undefined;
		const entity = response?.entity;
		if (entity?.id === undefined) {
			return ctx.format.error(
				'upstream_failure',
				`The wiki accepted the request but returned no entity: ${JSON.stringify(response)}`,
			);
		}

		return ctx.format.ok({
			entityId: entity.id,
			entityType: entity.type,
			latestRevisionId: entity.lastrevid,
		});
	},
};
