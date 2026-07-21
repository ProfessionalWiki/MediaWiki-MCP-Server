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

// Verified first-party CIMD hosts, trusted by default (closed posture). Adding a
// client = adding its document host here (or via MCP_OAUTH_CIMD_ALLOWED_HOSTS).
export const SHIPPED_CIMD_HOSTS: readonly string[] = [
	'vscode.dev',
	'claude.ai',
	'zed.dev',
	'chatgpt.com',
];

// Grammar: comma-separated, trimmed, blanks ignored. Each entry is a bare host
// (`vscode.dev`, matches that host on the default https port) or `host:port`.
// No scheme, path, or wildcard. Case-folded. A bad entry throws at boot.
export function parseCimdAllowedHosts(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.map((entry) => {
			// Reuse URL parsing to validate: `https://<entry>` must round-trip to the
			// same host[:port] with no path/query/fragment/userinfo.
			let u: URL;
			try {
				u = new URL(`https://${entry}`);
			} catch {
				throw new CimdValidationError(`not a valid CIMD host: ${entry}`);
			}
			if (
				u.pathname !== '/' ||
				u.search !== '' ||
				u.hash !== '' ||
				u.username !== '' ||
				u.host !== entry
			) {
				throw new CimdValidationError(`CIMD host entry must be a bare host or host:port: ${entry}`);
			}
			return entry;
		});
}

// The predicate applied to a candidate client_id's host (already case-folded by
// the caller as `url.host`). Composes the shipped defaults with operator entries.
export function buildCimdHostPredicate(operatorHosts: string[]): (host: string) => boolean {
	const allowed = new Set<string>([...SHIPPED_CIMD_HOSTS, ...operatorHosts]);
	return (host) => allowed.has(host.toLowerCase());
}
