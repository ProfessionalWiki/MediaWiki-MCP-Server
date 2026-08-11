import type { ExtensionPack } from '../types.ts';
import { wikibaseSearchEntities } from './wikibase-search-entities.ts';
import { wikibaseGetEntity } from './wikibase-get-entity.ts';
import { wikibaseQuery } from './wikibase-query.ts';
import { wikibaseEditEntity } from './wikibase-edit-entity.ts';
import { wikibaseAddStatement } from './wikibase-add-statement.ts';
import { WIKIBASE_ERROR_CODES, WIKIBASE_ERROR_CODE_PREFIXES } from './errorCodes.ts';

export const wikibasePack: ExtensionPack = {
	id: 'wikibase',
	// The repository half of Extension:Wikibase — the one that holds entities.
	// A wiki running only WikibaseClient reads another wiki's entities and has
	// none of these APIs.
	extensionNames: ['WikibaseRepository'],
	tools: [
		wikibaseSearchEntities,
		wikibaseGetEntity,
		wikibaseQuery,
		wikibaseEditEntity,
		wikibaseAddStatement,
	],
	errorCodes: WIKIBASE_ERROR_CODES,
	errorCodePrefixes: WIKIBASE_ERROR_CODE_PREFIXES,
	// The query service is a separate deployment from the wiki, so the extension
	// gate alone does not imply one exists. A repository that has one publishes
	// it in siteinfo, which the probe reads.
	wikiGate: {
		tools: [wikibaseQuery.name],
		isSatisfied: (identity) => (identity.sparqlEndpoint ?? '').trim() !== '',
		refusal: (wikiKey) =>
			`Wiki "${wikiKey}" advertises no query service, so SPARQL cannot be run against it. Use list-wikis to see which wikis have one.`,
	},
};
