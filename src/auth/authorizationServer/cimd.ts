export class CimdValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'CimdValidationError';
	}
}

// Routing hint only: an https URL is a candidate CIMD client_id. Opaque DCR ids
// (`mcp-<uuid>`) are not URLs, so the two id spaces never collide. Security does
// not rest on this — a CIMD is only honored after it is fetched and self-matches.
export function isCimdClientId(clientId: string): boolean {
	let u: URL;
	try {
		u = new URL(clientId);
	} catch {
		return false;
	}
	return u.protocol === 'https:';
}

// Enforce the IETF-draft MUSTs for a Client Identifier URL: https, no userinfo,
// no fragment, no dot-segments. A query component and a bare root path are the
// draft's SHOULD-NOTs, not MUST-NOTs, so they are accepted (rejecting them would
// break spec-conformant clients for no security gain).
export function validateClientIdUrl(clientId: string): URL {
	let u: URL;
	try {
		u = new URL(clientId);
	} catch {
		throw new CimdValidationError(`client_id is not a valid URL: ${clientId}`);
	}
	if (u.protocol !== 'https:') {
		throw new CimdValidationError('client_id must use https');
	}
	if (u.username !== '' || u.password !== '') {
		throw new CimdValidationError('client_id must not contain userinfo');
	}
	if (u.hash !== '') {
		throw new CimdValidationError('client_id must not contain a fragment');
	}
	// WHATWG URL collapses dot-segments on parse (and, for the special https
	// scheme, treats "\" as "/"), so inspect the raw PATH portion only — never the
	// query, which the spec allows to contain slash-dot substrings — with
	// backslashes normalized the way the URL parser would treat them.
	const rawPath = clientId.split(/[?#]/, 1)[0].replace(/\\/g, '/');
	if (/\/\.\.?(?:\/|$)/.test(rawPath)) {
		throw new CimdValidationError('client_id must not contain dot-segments');
	}
	return u;
}
