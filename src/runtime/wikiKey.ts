import { WIKI_RESOURCE_URI_PREFIX } from './constants.js';

// The mapping between a wiki key and the `mcp://wikis/` URI segment naming it.
// The config loader, the registry, the resource layer and the `wiki` tool
// argument all need it, and the config loader must not depend on wikis/.

export type WikiKeyProblem = 'empty' | 'resource-uri-collision' | 'not-encodable';

// Percent-encoding lets a key carry any character and still name a reachable
// resource, so only two shapes are refused. A key beginning with the resource
// prefix is indistinguishable from a URI to the `wiki` tool argument, which
// accepts both spellings and would strip the prefix to the wrong segment. A key
// that cannot be percent-encoded — an unpaired surrogate makes
// encodeURIComponent throw — would fail the whole of resources/list, not just
// its own entry.
export function wikiKeyProblem(key: string): WikiKeyProblem | undefined {
	if (key.trim() === '') {
		return 'empty';
	}
	if (key.startsWith(WIKI_RESOURCE_URI_PREFIX)) {
		return 'resource-uri-collision';
	}
	try {
		encodeURIComponent(key);
	} catch {
		return 'not-encodable';
	}
	return undefined;
}

export function wikiKeyProblemMessage(problem: WikiKeyProblem): string {
	switch (problem) {
		case 'empty':
			return 'cannot be empty';
		case 'resource-uri-collision':
			return `cannot start with "${WIKI_RESOURCE_URI_PREFIX}"`;
		default:
			return 'is not valid Unicode';
	}
}

// RFC 3986 admits ":" unescaped in a path segment. Escaping it would rewrite
// the URI of the host:port keys that ship in the default configuration. After
// encodeURIComponent every "%" begins a three-character escape, so the substring
// "%3A" is always a whole escape of ":" and never straddles a boundary.
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
