import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { formatEditComment } from '../../../wikis/utils.ts';

// Datatypes whose value this tool can build from a plain string. Everything
// else (time, quantity, coordinates, monolingual text) needs a structured
// datavalue, which wikibase-edit-entity takes directly.
const TEXT_DATATYPES: ReadonlySet<string> = new Set(['string', 'external-id', 'url']);

const inputSchema = {
	entityId: z
		.string()
		.regex(/^[QqPpLl]\d+$/, 'Item, property or lexeme ID, such as Q42, P31 or L1')
		.describe(
			'The item, property or lexeme the statement is added to. Other entity types, such as MediaInfo M-ids, are not supported.',
		),
	propertyId: z
		.string()
		.regex(/^[Pp]\d+$/, 'Property ID, such as P31')
		.describe('The property the statement is about.'),
	value: z
		.string()
		.min(1)
		.describe(
			'The value, as text: an entity ID (Q515) for a wikibase-item property, otherwise the literal string, identifier or URL.',
		),
	comment: z.string().optional().describe('Edit summary, appended to the generated one.'),
} as const;

interface PropertyResponse {
	datatype?: string;
	missing?: unknown;
}

interface CreateClaimResponse {
	claim?: { id?: string };
	pageinfo?: { lastrevid?: number };
}

export const wikibaseAddStatement: Tool<typeof inputSchema> = {
	name: 'wikibase-add-statement',
	description:
		"Adds one statement to a Wikibase item, property or lexeme and returns the new statement ID. Enabled only when the wiki is a Wikibase repository. Requires the edit right.\n\nThe value is given as text and interpreted by the property's datatype, which is read from the wiki first: an item ID such as Q515 for a wikibase-item property, and the literal text for a string, external-id or url property. A property of any other datatype is rejected, naming it; those statements go through wikibase-edit-entity, which takes the full statement JSON and also writes qualifiers, references and several statements at once.\n\nExisting statements are left in place, so calling twice with the same value leaves the entity holding it twice.",
	inputSchema,
	annotations: {
		title: 'Add Wikibase statement',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'add Wikibase statement',
	target: (a) => a.entityId,

	async handle(
		{ entityId, propertyId, value, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const entity = entityId.toUpperCase();
		const property = propertyId.toUpperCase();
		const mwn = await ctx.mwn();

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbgetentities response shape; trusted at this boundary
		const lookup = (await mwn.request({
			action: 'wbgetentities',
			ids: property,
			props: 'datatype',
			format: 'json',
			formatversion: '2',
		})) as { entities?: Record<string, PropertyResponse> };

		const definition = lookup.entities?.[property];
		if (definition === undefined || definition.missing !== undefined) {
			return ctx.format.notFound(`Property "${property}" not found`);
		}
		const datatype = definition.datatype;
		if (datatype === undefined) {
			return ctx.format.error(
				'upstream_failure',
				`The wiki reported no datatype for property "${property}".`,
			);
		}

		const snakValue = buildSnakValue(datatype, value);
		if (snakValue === undefined) {
			return ctx.format.invalidInput(
				datatype === 'wikibase-item'
					? `Property "${property}" has datatype "wikibase-item", so its value must be an item ID such as Q515, not "${value}".`
					: `Property "${property}" has datatype "${datatype}", which wikibase-add-statement cannot build a value for. Use wikibase-edit-entity with the statement JSON instead.`,
			);
		}

		const summary = formatEditComment(ctx, 'wikibase-add-statement', comment);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbcreateclaim response shape; trusted at this boundary
		const response = (await ctx.edit.submit(mwn, {
			action: 'wbcreateclaim',
			entity,
			property,
			snaktype: 'value',
			value: snakValue,
			...(summary !== undefined ? { summary } : {}),
		})) as CreateClaimResponse | undefined;

		const statementId = response?.claim?.id;
		if (statementId === undefined) {
			return ctx.format.error(
				'upstream_failure',
				`The wiki accepted the request but returned no statement: ${JSON.stringify(response)}`,
			);
		}

		return ctx.format.ok({
			entityId: entity,
			propertyId: property,
			statementId,
			latestRevisionId: response?.pageinfo?.lastrevid,
		});
	},
};

/** The JSON datavalue for this datatype, or undefined when it cannot be built. */
function buildSnakValue(datatype: string, value: string): string | undefined {
	if (datatype === 'wikibase-item') {
		return /^[Qq]\d+$/.test(value)
			? JSON.stringify({ 'entity-type': 'item', id: value.toUpperCase() })
			: undefined;
	}
	return TEXT_DATATYPES.has(datatype) ? JSON.stringify(value) : undefined;
}
