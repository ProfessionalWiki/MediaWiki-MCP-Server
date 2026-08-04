import type { ExtensionPack } from '../types.ts';
import { wikibaseSearchEntities } from './wikibase-search-entities.ts';
import { wikibaseGetEntity } from './wikibase-get-entity.ts';
import { wikibaseQuery } from './wikibase-query.ts';
import { wikibaseEditEntity } from './wikibase-edit-entity.ts';
import { wikibaseAddStatement } from './wikibase-add-statement.ts';

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
	// The query service is a separate deployment from the wiki, so the extension
	// gate alone does not imply one exists: each wiki names its own or has none.
	wikiGate: {
		tools: [wikibaseQuery.name],
		isSatisfied: (wiki) => (wiki.sparqlEndpoint ?? '').trim() !== '',
		refusal: (wikiKey) =>
			`Wiki "${wikiKey}" has no query service: set sparqlEndpoint in its configuration to the SPARQL endpoint URL.`,
	},
};
