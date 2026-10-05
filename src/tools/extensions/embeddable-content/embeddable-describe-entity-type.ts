import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { resolveVocabulary } from './embeddableVocabulary.ts';

interface SourceFieldContract {
	classes: {
		classKey?: string;
		label?: string;
		classItemId?: string;
		parentClass?: string | null;
		fields?: string[];
		requiredOnCreate?: string[];
	}[];
	propertyIds: {
		instanceOf?: string;
		provenance?: Record<string, string>;
		citationMetadata?: Record<string, string>;
		sourceProperties?: Record<string, string>;
		externalIds?: Record<string, string>;
	};
}

interface SpecialContentFieldContract {
	flows: {
		kind?: string;
		class?: { id: string; label?: string };
		payloadProperty?: { id: string; datatype: string };
		fields?: string[];
		requiredOnCreate?: string[];
	}[];
	example: Record<string, string>;
	propertyIds: {
		instanceOf?: string;
		payloadProperties?: Record<string, string>;
		programmingLanguage?: string;
		describes?: string | null;
		implementationOf?: string | null;
		translation?: string | null;
		note?: string | null;
		provenance?: Record<string, string>;
	};
}

/**
 * Fetches the special-content field contract from the wiki's own
 * action=addspecialcontent-fields endpoint. Returns undefined when the wiki
 * did not answer it (an EmbeddableContent version too old to serve it).
 */
async function fetchSpecialContentFields(
	ctx: ToolContext,
): Promise<SpecialContentFieldContract | undefined> {
	const mwn = await ctx.mwn();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=addspecialcontent-fields response shape; trusted at this boundary
	const response = (await mwn.request({
		action: 'addspecialcontent-fields',
		formatversion: '2',
	})) as {
		contentfields?: {
			kinds?: {
				kind?: string;
				classItemId?: string;
				payloadPropertyId?: string;
				fields?: string[];
				requiredOnCreate?: string[];
			}[];
			propertyIds?: SpecialContentFieldContract['propertyIds'];
		};
	};
	const fields = response.contentfields;
	if (fields?.kinds === undefined || fields.propertyIds === undefined) {
		return undefined;
	}
	return {
		flows: fields.kinds.map((k) => ({
			kind: k.kind,
			...(k.classItemId !== undefined ? { class: { id: k.classItemId, label: k.kind } } : {}),
			...(k.payloadPropertyId !== undefined
				? {
						payloadProperty: {
							id: k.payloadPropertyId,
							datatype: k.kind === 'quotation' ? 'monolingualtext' : 'string',
						},
					}
				: {}),
			fields: k.fields ?? [],
			requiredOnCreate: k.requiredOnCreate ?? [],
		})),
		example: {
			kind: 'quotation',
			label: 'First words of the quote',
			content: 'The quotation text',
			language: 'en',
			attributedTo: 'Q94',
		},
		propertyIds: fields.propertyIds,
	};
}

/**
 * Fetches the citation-source field contract from the wiki's own
 * action=addsource-fields endpoint. Returns undefined when the wiki did not
 * answer it (an EmbeddableContent version too old to serve it).
 */
async function fetchCitationSource(ctx: ToolContext): Promise<SourceFieldContract | undefined> {
	const mwn = await ctx.mwn();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=addsource-fields response shape; trusted at this boundary
	const response = (await mwn.request({
		action: 'addsource-fields',
		formatversion: '2',
	})) as { sourcefields?: SourceFieldContract };
	const fields = response.sourcefields;
	if (fields?.classes === undefined || fields.propertyIds === undefined) {
		return undefined;
	}
	return fields;
}

const inputSchema = {
	kind: z
		.enum(['special-content', 'citation-source', 'semantic-entity'])
		.optional()
		.describe(
			'Narrow the report to one family: the special-content Add* forms (quotation, math, code-snippet), the citation-source AddSource classes, or the semantic-entity Add* forms (person, software, collective, fictional-character, other). Omitted, all are returned.',
		),
} as const;

export const embeddableDescribeEntityType: Tool<typeof inputSchema> = {
	name: 'embeddable-describe-entity-type',
	description:
		'Returns the field tables, resolved property IDs and a ready-to-submit example for the EmbeddableContent Add* flows, as the discovery counterpart of embeddable-add-special-content, embeddable-add-citation-source and embeddable-add-semantic-entity. Enabled only when the wiki has the EmbeddableContent extension.\n\nCall this before the add tools to see exactly which fields a kind or class exposes, which properties they are stored on (resolved on this wiki), and a JSON example of a full submission.',
	inputSchema,
	annotations: {
		title: 'Describe entity type',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'describe entity type',
	target: (a) => a.kind ?? 'all',
	async handle({ kind }, ctx: ToolContext): Promise<CallToolResult> {
		const { vocabulary, missing } = await resolveVocabulary(ctx);

		// Both add-flow sections are served by the wiki's own fields
		// endpoints — the field contracts (SourceFieldMap, SpecialContentFieldMap)
		// have one publisher each, so discovery can never drift from the
		// add flows. The semantic-entity section is still local (Phase 3).
		const specialContent =
			kind === undefined || kind === 'special-content'
				? await fetchSpecialContentFields(ctx)
				: undefined;
		const citationSource =
			kind === undefined || kind === 'citation-source' ? await fetchCitationSource(ctx) : undefined;
		if (kind === 'citation-source' && citationSource === undefined) {
			return ctx.format.error(
				'upstream_failure',
				'The wiki did not answer action=addsource-fields — its EmbeddableContent version is too old to serve the source field contract.',
			);
		}
		if (kind === 'special-content' && specialContent === undefined) {
			return ctx.format.error(
				'upstream_failure',
				'The wiki did not answer action=addspecialcontent-fields — its EmbeddableContent version is too old to serve the special-content field contract.',
			);
		}
		const semanticEntity =
			kind === undefined || kind === 'semantic-entity'
				? await fetchSemanticEntityFields(ctx)
				: undefined;
		if (kind === 'semantic-entity' && semanticEntity === undefined) {
			return ctx.format.error(
				'upstream_failure',
				'The wiki did not answer action=addsemanticentity-fields — its EmbeddableContent version is too old to serve the semantic-entity field contract.',
			);
		}
		// The property ids come from the wiki's config (via the fields
		// endpoints when they answered); the rest resolve locally.
		const sourcePropertyIds = citationSource?.propertyIds;
		const contentPropertyIds = specialContent?.propertyIds;
		const semanticPropertyIds = semanticEntity?.propertyIds;

		return ctx.format.ok({
			propertyIds: {
				instanceOf: sourcePropertyIds?.instanceOf ?? vocabulary.instanceOf,
				payloadProperties: contentPropertyIds?.payloadProperties ?? vocabulary.payloadProperties,
				programmingLanguage:
					contentPropertyIds?.programmingLanguage ?? vocabulary.programmingLanguage,
				provenance: sourcePropertyIds?.provenance ?? vocabulary.provenance,
				describes: contentPropertyIds?.describes ?? vocabulary.describes,
				implementationOf: contentPropertyIds?.implementationOf ?? vocabulary.implementationOf,
				citationMetadata: sourcePropertyIds?.citationMetadata ?? vocabulary.citationMetadata,
				sourceProperties: sourcePropertyIds?.sourceProperties ?? vocabulary.sourceProperties,
				externalIds: sourcePropertyIds?.externalIds ?? vocabulary.externalIds,
				personProperties: semanticPropertyIds?.personProperties ?? vocabulary.personProperties,
				fossProperties: semanticPropertyIds?.fossProperties ?? vocabulary.fossProperties,
				collectiveProperties:
					semanticPropertyIds?.collectiveProperties ?? vocabulary.collectiveProperties,
				fictionalCharacter:
					semanticPropertyIds?.fictionalCharacter ?? vocabulary.fictionalCharacter,
			},
			...(specialContent !== undefined ? { specialContent } : {}),
			...(citationSource !== undefined ? { citationSource } : {}),
			...(semanticEntity !== undefined ? { semanticEntity } : {}),
			...(missing.length > 0
				? {
						unresolvedVocabulary: missing,
					}
				: {}),
		});
	},
};

interface SemanticEntityFieldContract {
	kinds: {
		kind?: string;
		fields?: string[];
		requiredOnCreate?: string[];
		example?: Record<string, string>;
	}[];
	propertyIds: {
		instanceOf?: string;
		programmingLanguage?: string;
		personProperties?: Record<string, string>;
		fossProperties?: Record<string, string>;
		collectiveProperties?: Record<string, string>;
		fictionalCharacter?: Record<string, string>;
		externalIds?: Record<string, string>;
	};
}

/** The example submission per kind, shown by the discovery output. */
const SEMANTIC_EXAMPLES: Record<string, Record<string, string>> = {
	person: {
		kind: 'person',
		givenName: 'Ada',
		familyName: 'Lovelace',
		orcid: '0000-0000-0000-0000',
	},
	software: { kind: 'software', label: 'Example FOSS Project', license: 'Q302' },
	collective: {
		kind: 'collective',
		label: 'Example Organization',
		collectiveClass: 'non-profit-organization',
	},
	'fictional-character': {
		kind: 'fictional-character',
		givenName: 'Sherlock',
		familyName: 'Holmes',
		presentInWork: 'Q42',
	},
	other: { kind: 'other', label: 'Anything', instanceOf: 'Q163' },
};

/**
 * Fetches the semantic-entity field contract from the wiki's own
 * action=addsemanticentity-fields endpoint. Returns undefined when the wiki
 * did not answer it (an EmbeddableContent version too old to serve it).
 */
async function fetchSemanticEntityFields(
	ctx: ToolContext,
): Promise<SemanticEntityFieldContract | undefined> {
	const mwn = await ctx.mwn();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=addsemanticentity-fields response shape; trusted at this boundary
	const response = (await mwn.request({
		action: 'addsemanticentity-fields',
		formatversion: '2',
	})) as {
		semanticfields?: {
			kinds?: {
				kind?: string;
				fields?: string[];
				requiredOnCreate?: string[];
			}[];
			propertyIds?: SemanticEntityFieldContract['propertyIds'];
		};
	};
	const fields = response.semanticfields;
	if (fields?.kinds === undefined || fields.propertyIds === undefined) {
		return undefined;
	}
	return {
		kinds: fields.kinds.map((k) => ({
			kind: k.kind,
			fields: k.fields ?? [],
			requiredOnCreate: k.requiredOnCreate ?? [],
			...(k.kind !== undefined && SEMANTIC_EXAMPLES[k.kind] !== undefined
				? { example: SEMANTIC_EXAMPLES[k.kind] }
				: {}),
		})),
		propertyIds: fields.propertyIds,
	};
}
