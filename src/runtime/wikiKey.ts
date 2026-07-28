// The mapping between a wiki key and the `mcp://wikis/` URI segment naming it.
// Lives here rather than under wikis/ because the config loader, the registry,
// the resource layer and the `wiki` tool argument all need it, and config must
// not depend on wikis/.

// A key carrying any of these cannot round-trip through every surface that
// names a wiki: the `wiki` tool argument takes either a bare key or a full
// mcp://wikis/ URI, and those two spellings only agree while the key needs no
// percent-encoding.
const UNSAFE_WIKI_KEY_CHARS = /[/?#\s]/;

export function hasUnsafeWikiKeyChars(key: string): boolean {
	if (UNSAFE_WIKI_KEY_CHARS.test(key)) {
		return true;
	}
	// An unpaired surrogate makes encodeURIComponent throw, which would fail the
	// whole of resources/list rather than this one key.
	try {
		encodeURIComponent(key);
		return false;
	} catch {
		return true;
	}
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
