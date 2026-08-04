import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { errorMessage } from '../../../errors/isErrnoException.ts';
import type { Claims, HiddenValues, RenderedClaims } from './entityFormat.ts';
import {
	capProperties,
	MAX_PROPERTIES,
	MAX_VALUES_PER_PROPERTY,
	referencedEntityIds,
	renderClaims,
} from './entityFormat.ts';
import { capLinesByBytes } from '../../../results/truncation.ts';
import { fetchLabels, LANGUAGE_CODE, labelOf, resolveLanguage } from './wikibaseApi.ts';

const inputSchema = {
	entityId: z
		.string()
		.regex(/^[A-Za-z]+\d+$/, 'Entity ID, such as Q42 or P31')
		.describe('The entity to read, e.g. Q42 for an item or P31 for a property.'),
	language: z
		.string()
		.regex(LANGUAGE_CODE, 'A single language code, such as en or pt-br')
		.optional()
		.describe(
			'Language code the label, description and aliases are returned in, with fallback to the languages the wiki configures. Defaults to the wiki content language.',
		),
	property: z
		.string()
		.regex(/^[Pp]\d+$/, 'Property ID, such as P31')
		.optional()
		.describe(
			'Restricts the statements to this one property, and reads every value it holds. The way to read a heavily-used property on an entity whose full statement list is capped.',
		),
} as const;

interface TermValue {
	value?: string;
}

interface EntityResponse {
	id?: string;
	type?: string;
	datatype?: string;
	missing?: unknown;
	labels?: Record<string, TermValue | undefined>;
	descriptions?: Record<string, TermValue | undefined>;
	aliases?: Record<string, TermValue[] | undefined>;
	claims?: Claims;
}

export const wikibaseGetEntity: Tool<typeof inputSchema> = {
	name: 'wikibase-get-entity',
	description: `Returns one Wikibase entity as compact text: its label, description and aliases, then its statements, one line per property in the form \`P106 (occupation): Q36834 (composer)\`. Enabled only when the wiki is a Wikibase repository. A property entity also reports its datatype.\n\nReferenced property and item IDs carry their labels, so values read as names rather than as bare Q-ids; on a heavily-described entity, an ID past the label-lookup budget appears bare. Qualifiers and references are summarised by count, not listed. Statements are ordered preferred rank first; deprecated ones are marked.\n\nEntities on a large Wikibase carry hundreds of statements, so the statement list is capped at ${MAX_PROPERTIES} properties and ${MAX_VALUES_PER_PROPERTY} values per property, and the response body is truncated at 50000 bytes by default; set property to read one property in full. To find an entity's ID, use wikibase-search-entities.`,
	inputSchema,
	annotations: {
		title: 'Get Wikibase entity',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'get Wikibase entity',
	target: (a) => a.entityId,

	async handle({ entityId, language, property }, ctx: ToolContext): Promise<CallToolResult> {
		const id = entityId.toUpperCase();
		const termLanguage = await resolveLanguage(ctx, language);
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbgetentities response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'wbgetentities',
			ids: id,
			props: 'labels|descriptions|aliases|claims|datatype',
			languages: termLanguage,
			languagefallback: 1,
			format: 'json',
			formatversion: '2',
		})) as { entities?: Record<string, EntityResponse> };

		// A redirected ID comes back under the key that was asked for, carrying the
		// target's content and reporting the target in `id`.
		const entity = (response.entities ?? {})[id];
		if (entity === undefined || entity.missing !== undefined) {
			return ctx.format.notFound(`Entity "${id}" not found`);
		}

		// Naming one property is a request to read it in full, so only the shared
		// byte budget bounds it.
		const maxValues = property === undefined ? MAX_VALUES_PER_PROPERTY : Number.POSITIVE_INFINITY;
		const { claims, totalProperties } = capProperties(selectClaims(entity.claims ?? {}, property));
		const labels = await resolveLabels(ctx, mwn, claims, maxValues, termLanguage);
		const rendered = renderClaims(claims, (referenced) => labels.get(referenced), maxValues);
		const capped = capLinesByBytes(rendered.lines);

		return ctx.format.ok({
			entityId: entity.id ?? id,
			// The id the caller asked for, when the wiki answered with another one:
			// entityId already reports where a redirect landed.
			...(entity.id !== undefined && entity.id !== id ? { redirectedFrom: id } : {}),
			...optional('label', labelOf(entity, termLanguage)),
			...optional('description', termOf(entity.descriptions, termLanguage)),
			...optional('datatype', entity.datatype),
			...(aliasesOf(entity, termLanguage).length > 0
				? { aliases: aliasesOf(entity, termLanguage) }
				: {}),
			statements: capped.lines,
			...truncationOf(capped, rendered, totalProperties),
		});
	},
};

function selectClaims(claims: Claims, property: string | undefined): Claims {
	if (property === undefined) {
		return claims;
	}
	const propertyId = property.toUpperCase();
	return Object.hasOwn(claims, propertyId) ? { [propertyId]: claims[propertyId] } : {};
}

// A failed label lookup degrades the rendering to bare IDs rather than failing
// the read: the statements themselves are already in hand.
async function resolveLabels(
	ctx: ToolContext,
	mwn: Awaited<ReturnType<ToolContext['mwn']>>,
	claims: Claims,
	maxValuesPerProperty: number,
	language: string,
): Promise<Map<string, string>> {
	const ids = referencedEntityIds(claims, maxValuesPerProperty);
	if (ids.length === 0) {
		return new Map();
	}
	return await fetchLabels(mwn, ids, language, (err) =>
		ctx.logger.warning('Wikibase label lookup failed', { error: errorMessage(err) }),
	);
}

function truncationOf(
	capped: { lines: string[]; returnedBytes: number; totalBytes: number; truncated: boolean },
	rendered: RenderedClaims,
	totalProperties: number,
): { truncation?: TruncationInfo } {
	const renderedProperties = rendered.lines.length;
	if (capped.truncated) {
		return {
			truncation: {
				reason: 'content-truncated',
				returnedBytes: capped.returnedBytes,
				totalBytes: capped.totalBytes,
				itemNoun: 'statements',
				toolName: 'wikibase-get-entity',
				remedyHint: byteCapRemedy(rendered.hidden, totalProperties, renderedProperties),
			},
		};
	}
	if (renderedProperties < totalProperties) {
		// The property cap can fire while the value cap is also hiding values, and
		// a caller who then reads one property back would find it short without
		// having been told anything hid it.
		const alsoHidden =
			rendered.hidden.length === 0 ? '' : `, and ${hiddenValuesPhrase(rendered.hidden)}`;
		return {
			truncation: {
				reason: 'capped-no-continuation',
				returnedCount: renderedProperties,
				limit: MAX_PROPERTIES,
				itemNoun: 'properties',
				narrowHint: `the entity has ${totalProperties}${alsoHidden} — call wikibase-get-entity again with property=<P-id> to read one of them in full.`,
			},
		};
	}
	if (rendered.hidden.length > 0) {
		return {
			truncation: {
				reason: 'capped-no-continuation',
				returnedCount: rendered.shownValues,
				limit: MAX_VALUES_PER_PROPERTY,
				itemNoun: 'values',
				narrowHint: `${hiddenValuesPhrase(rendered.hidden)} — ${readOneInFull(rendered.hidden)}`,
			},
		};
	}
	return {};
}

function readOneInFull(hidden: HiddenValues[]): string {
	return hidden.length === 1
		? `call wikibase-get-entity with property=${hidden[0].propertyId} to read it in full.`
		: 'call wikibase-get-entity with property=<P-id> to read one in full.';
}

// A byte-truncated response may also have hit the property or value caps, and a
// caller told only about the bytes would page through the rest still missing
// what the counts dropped.
function byteCapRemedy(
	hidden: HiddenValues[],
	totalProperties: number,
	renderedProperties: number,
): string {
	const alsoCapped: string[] = [];
	if (renderedProperties < totalProperties) {
		alsoCapped.push(
			`The entity has ${totalProperties} properties; ${renderedProperties} were rendered before the byte cap`,
		);
	}
	if (hidden.length > 0) {
		alsoCapped.push(hiddenValuesPhrase(hidden));
	}
	return alsoCapped.length === 0
		? 'To read one property in full, call wikibase-get-entity again with property=<P-id>.'
		: `${alsoCapped.join('; ')} — call wikibase-get-entity with property=<P-id> to read one in full.`;
}

/**
 * What the value cap hid. Naming every property would be as long as the response
 * it explains, so several are reported by count plus the one that lost the most,
 * which is the property a caller has most reason to read on its own.
 */
function hiddenValuesPhrase(hidden: HiddenValues[]): string {
	const largest = hidden.reduce((worst, group) =>
		group.total - group.shown > worst.total - worst.shown ? group : worst,
	);
	if (hidden.length === 1) {
		return `${largest.propertyId} shows ${largest.shown} of ${largest.total} values`;
	}
	return `${hidden.length} properties have more values than shown; the largest, ${largest.propertyId}, shows ${largest.shown} of ${largest.total}`;
}

function termOf(
	terms: Record<string, TermValue | undefined> | undefined,
	language: string,
): string | undefined {
	const requested = terms?.[language]?.value;
	if (typeof requested === 'string') {
		return requested;
	}
	for (const term of Object.values(terms ?? {})) {
		if (typeof term?.value === 'string') {
			return term.value;
		}
	}
	return undefined;
}

function aliasesOf(entity: EntityResponse, language: string): string[] {
	const forLanguage = entity.aliases?.[language] ?? [];
	return forLanguage
		.map((alias) => alias.value)
		.filter((value): value is string => typeof value === 'string');
}

function optional(key: string, value: string | undefined): Record<string, string> {
	return value === undefined || value === '' ? {} : { [key]: value };
}
