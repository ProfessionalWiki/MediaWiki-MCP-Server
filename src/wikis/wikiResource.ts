import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.js';

export interface ParsedWikiUri {
	wikiKey: string;
}

export class InvalidWikiResourceUriError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'InvalidWikiResourceUriError';
	}
}

// A key carrying any of these cannot round-trip through every surface that
// names a wiki: the `wiki` tool argument takes either a bare key or a full
// mcp://wikis/ URI, and those two spellings only agree while the key needs no
// percent-encoding.
const UNSAFE_WIKI_KEY_CHARS = /[/?#\s]/;

export function hasUnsafeWikiKeyChars(key: string): boolean {
	return UNSAFE_WIKI_KEY_CHARS.test(key);
}

// RFC 3986 admits ":" unescaped in a path segment. Escaping it would rewrite
// the URI of the host:port keys that ship in the default configuration.
export function encodeWikiKey(key: string): string {
	return encodeURIComponent(key).replaceAll('%3A', ':');
}

// Undefined when the segment is not valid percent-encoding: decodeURIComponent
// throws URIError on a stray "%", and the segment comes from the client.
export function decodeWikiKey(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch (error) {
		if (error instanceof URIError) {
			return undefined;
		}
		throw error;
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
