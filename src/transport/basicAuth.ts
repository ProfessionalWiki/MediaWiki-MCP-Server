import type { Request } from 'express';
import type { RuntimeCredentials } from '../runtime/requestContext.ts';

// Reads RFC 7617 `Authorization: Basic` credentials off a request. The pair is a
// MediaWiki bot password — the same `username` / `password` a wiki can carry in
// config.json — supplied per request instead, so the server acts as the caller
// rather than as one identity shared by everybody it serves.

export type BasicAuthHeader =
	// No Basic header (absent entirely, or another scheme this module leaves alone).
	| { readonly kind: 'absent' }
	| { readonly kind: 'credentials'; readonly credentials: RuntimeCredentials }
	// A Basic header that carries no usable pair. Kept distinct from `absent`: a
	// caller that meant to authenticate must be told so, not served anonymously
	// under an identity it does not have.
	| { readonly kind: 'malformed'; readonly reason: string };

// Standard base64 only. `Buffer.from` silently discards anything outside the
// alphabet, so an unpadded, url-safe or truncated value would otherwise decode
// to plausible-looking garbage instead of being reported as malformed.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function readBasicAuthHeader(req: Pick<Request, 'headers'>): BasicAuthHeader {
	const raw = req.headers.authorization;
	if (typeof raw !== 'string') {
		return { kind: 'absent' };
	}
	// Duplicate headers arrive comma-joined, as extractBearerToken also handles.
	// A comma cannot occur inside the base64 payload, so the first value is whole.
	const first = raw.split(',')[0].trim();
	const scheme = first.toLowerCase();
	if (scheme !== 'basic' && !scheme.startsWith('basic ')) {
		return { kind: 'absent' };
	}
	const encoded = first.slice(5).trim();
	if (encoded === '' || !BASE64_PATTERN.test(encoded)) {
		return { kind: 'malformed', reason: 'the credentials are not valid base64' };
	}
	const decoded = Buffer.from(encoded, 'base64').toString('utf8');
	const separator = decoded.indexOf(':');
	if (separator < 0) {
		return { kind: 'malformed', reason: 'the decoded credentials contain no ":" separator' };
	}
	// Only the FIRST colon separates: a MediaWiki bot password is generated with
	// no colon in it, but nothing guarantees that of a password a caller supplies.
	const username = decoded.slice(0, separator);
	const password = decoded.slice(separator + 1);
	if (username === '' || password === '') {
		return { kind: 'malformed', reason: 'both a username and a password are required' };
	}
	return { kind: 'credentials', credentials: { username, password } };
}
