// AUTO-GENERATED — do not edit by hand.
//
// Source: contract/field-contract.json, emitted by the ronzz-wikibase
// EmbeddableContent extension (maintenance/emitFieldContract.php). The wiki's
// Flow/*FieldMap classes are the single authoring source; this file is a
// projection of the contract they publish.
//
// Regenerate: npm run gen:field-contract
//
// Each add tool declares its field validators as
// `satisfies Record<<Field>, z.ZodTypeAny>`, so adding, renaming or removing a
// contract field fails compilation until the tool and the generator's
// EXCLUDED map are brought in step — the drift guard.

export const SPECIAL_CONTENT_KINDS = ['quotation', 'math', 'code-snippet'] as const;
export type SpecialContentKind = (typeof SPECIAL_CONTENT_KINDS)[number];

export const SPECIAL_CONTENT_FIELD_NAMES = [
	'label',
	'content',
	'labelLanguage',
	'language',
	'translations',
	'attributedTo',
	'source',
	'sourceUrl',
	'date',
	'note',
	'describes',
	'programmingLanguage',
	'implementationOf',
] as const;
export type SpecialContentField = (typeof SPECIAL_CONTENT_FIELD_NAMES)[number];

export const SOURCE_CLASS_KEYS = [
	'book',
	'scholarly-article',
	'website',
	'webpage',
	'song',
	'film',
	'video',
	'youtube-channel',
	'youtube-video',
	'book-excerpt',
	'newspaper-article',
	'magazine-article',
	'conference-paper',
	'report',
	'document',
	'thesis',
	'manuscript',
	'patent',
	'legal-case',
	'legislation',
	'bill',
	'treaty',
	'interview',
	'map',
	'presentation',
	'dataset',
	'text',
] as const;
export type SourceClassKey = (typeof SOURCE_CLASS_KEYS)[number];

export const SOURCE_FIELD_NAMES = [
	'title',
	'description',
	'language',
	'authors',
	'publisher',
	'pages',
	'year',
	'isbn',
	'accessUrl',
	'wikidataId',
	'journal',
	'volume',
	'issue',
	'doi',
	'openalexWorkId',
	'pubmedId',
	'url',
	'parent',
	'duration',
	'youtubeChannelId',
	'youtubeVideoId',
	'chapters',
	'reportNumber',
	'patentNumber',
	'court',
	'territorialJurisdiction',
	'territorialJurisdictionLabel',
	'caseNumber',
	'international',
	'legislationNumber',
] as const;
export type SourceField = (typeof SOURCE_FIELD_NAMES)[number];

export const SEMANTIC_ENTITY_KINDS = [
	'person',
	'software',
	'collective',
	'fictional-character',
	'other',
] as const;
export type SemanticEntityKind = (typeof SEMANTIC_ENTITY_KINDS)[number];

export const SEMANTIC_ENTITY_FIELD_NAMES = [
	'givenName',
	'familyName',
	'description',
	'dateOfBirth',
	'placeOfBirth',
	'dateOfDeath',
	'placeOfDeath',
	'orcid',
	'viafId',
	'isni',
	'wikidataId',
	'openalexAuthorId',
	'officialWebsite',
	'label',
	'developer',
	'license',
	'programmingLanguage',
	'operatingSystem',
	'userInterface',
	'hasUse',
	'sourceCodeRepository',
	'documentationUrl',
	'collectiveClass',
	'parentOrganization',
	'alias',
	'presentInWork',
	'instanceOf',
] as const;
export type SemanticEntityField = (typeof SEMANTIC_ENTITY_FIELD_NAMES)[number];
