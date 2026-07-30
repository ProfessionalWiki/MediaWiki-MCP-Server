import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.ts';
import { decodeWikiKey } from '../runtime/wikiKey.ts';

export interface ParsedWikiUri {
	wikiKey: string;
}

export class InvalidWikiResourceUriError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'InvalidWikiResourceUriError';
	}
}

export function parseWikiResourceUri(uri: string): ParsedWikiUri {
	if (!uri.startsWith(WIKI_RESOURCE_URI_PREFIX)) {
		throw new InvalidWikiResourceUriError(
			`Invalid wiki resource URI. Must start with "${WIKI_RESOURCE_URI_PREFIX}".`,
		);
	}

	const segment = uri.slice(WIKI_RESOURCE_URI_PREFIX.length).trim();

	if (!segment) {
		throw new InvalidWikiResourceUriError('Invalid wiki resource URI. Wiki key cannot be empty.');
	}

	const wikiKey = decodeWikiKey(segment);

	if (wikiKey === undefined) {
		throw new InvalidWikiResourceUriError(
			'Invalid wiki resource URI. Wiki key is not valid percent-encoding.',
		);
	}

	return { wikiKey };
}
