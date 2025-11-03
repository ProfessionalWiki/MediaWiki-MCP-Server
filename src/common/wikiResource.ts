import { WIKI_RESOURCE_URI_PREFIX } from './constants.js';

export interface ParsedWikiUri {
	wikiKey: string;
}

export class InvalidWikiResourceUriError extends Error {
	public constructor( message: string ) {
		super( message );
		this.name = 'InvalidWikiResourceUriError';
	}
}

export function parseWikiResourceUri( uri: string ): ParsedWikiUri {
	if ( !uri.startsWith( WIKI_RESOURCE_URI_PREFIX ) ) {
		throw new InvalidWikiResourceUriError(
			`Invalid wiki resource URI. Must start with "${ WIKI_RESOURCE_URI_PREFIX }".`
		);
	}

	const wikiKey = uri.slice( WIKI_RESOURCE_URI_PREFIX.length ).trim();

	if ( !wikiKey || wikiKey === '' ) {
		throw new InvalidWikiResourceUriError( 'Invalid wiki resource URI. Wiki key cannot be empty.' );
	}

	return { wikiKey };
}
