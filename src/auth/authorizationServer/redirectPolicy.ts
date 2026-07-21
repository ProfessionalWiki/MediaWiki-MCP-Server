const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

// RFC 8252 §7.3 loopback hosts. WHATWG URL reports the bracketed form for IPv6.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTNAMES.has(hostname);
}

export type AllowlistEntry =
	| { kind: 'exact'; uri: string }
	| { kind: 'prefix'; origin: string; pathPrefix: string };

export type RedirectAllowlist = AllowlistEntry[];

export class RedirectAllowlistError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'RedirectAllowlistError';
	}
}

// --- Source 1: structural built-ins -----------------------------------------
// Hard-wired predicates that no operator config can add to or remove. Kept as
// predicates (not AllowlistEntry data) on purpose: the claude.ai check compares
// only origin+pathname so it tolerates a query/hash, which an exact entry would
// not, and the loopback check spans any port.

// RFC 8252 loopback: http on 127.0.0.1 / localhost / [::1], any port.
function isLoopbackRedirect(redirectUri: string): boolean {
	let u: URL;
	try {
		u = new URL(redirectUri);
	} catch {
		return false;
	}
	return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

// The exact claude.ai callback. Origin+pathname equality, so a query/hash on the
// callback still matches — do not fold this into an exact AllowlistEntry.
function isClaudeAiRedirect(redirectUri: string): boolean {
	let u: URL;
	try {
		u = new URL(redirectUri);
	} catch {
		return false;
	}
	return u.protocol === 'https:' && `${u.origin}${u.pathname}` === CLAUDE_AI_CALLBACK;
}

// Built-in base policy: http loopback (any port) plus the exact claude.ai
// callback. Operator entries (below) only ever ADD to this — never replace it —
// so a deployment cannot misconfigure its way into breaking loopback clients.
export function isAllowedRedirect(redirectUri: string): boolean {
	return isLoopbackRedirect(redirectUri) || isClaudeAiRedirect(redirectUri);
}

// --- Source 2: shipped client defaults --------------------------------------
// Verified first-party vendor callbacks trusted by default, with no operator
// config. Each string is run through the SAME parseEntry the operator allowlist
// uses, so a typo fails fast at module load and a shipped entry is validated
// exactly like an operator entry. Kept its own group (not folded into the
// source-1 hard built-ins) so it can later be made operator-overridable on its
// own. Adding a client = adding its callback string(s) below.
//
// Security: every origin below is controlled by the named vendor, so an attacker
// cannot receive a token at it. Trusting them by default adds no phishing sink,
// while arbitrary hosts stay excluded by construction.
const SHIPPED_CLIENT_DEFAULTS: AllowlistEntry[] = [
	// ChatGPT (openai / chatgpt.com). The per-connector prefix absorbs
	// connector-id churn; the exact legacy path covers already-published apps.
	'https://chatgpt.com/connector/oauth/*',
	'https://chatgpt.com/connector_platform_oauth_redirect',
	// Cursor (cursor.com). The hosted callback plus the cursor:// custom-scheme
	// desktop callback. A local app registering that scheme handler could receive
	// the code, but that is a local-attacker scenario that already implies code
	// execution on the machine, so it is acceptable.
	'https://www.cursor.com/agents/mcp/oauth/callback',
	'cursor://anysphere.cursor-mcp/oauth/callback',
].map(parseEntry);

/**
 * Parses MCP_OAUTH_ALLOWED_REDIRECTS. Grammar (comma-separated, trimmed,
 * blanks ignored):
 * - `<https-base>/*`: prefix pattern. The base must be https with no query,
 *   fragment, or credentials; matching compares origin equality plus a
 *   WHATWG-normalized pathname prefix, so `..` cannot escape it.
 * - anything else: exact entry — any parseable absolute URI (custom schemes
 *   included, e.g. cursor://…), matched byte-for-byte.
 */
export function parseRedirectAllowlist(raw: string | undefined): RedirectAllowlist {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map(parseEntry);
}

function parseEntry(item: string): AllowlistEntry {
	if (item.endsWith('/*')) {
		// Strip the '*', keep the trailing slash. Load-bearing: it makes the
		// stored pathPrefix end in '/', which is what stops `/connector/oauth/*`
		// from matching a sibling segment like `/connector/oauthEVIL/…`.
		const base = item.slice(0, -1);
		let u: URL;
		try {
			u = new URL(base);
		} catch {
			throw new RedirectAllowlistError(`not a valid URL: ${item}`);
		}
		if (u.protocol !== 'https:') {
			throw new RedirectAllowlistError(`pattern entries must be https: ${item}`);
		}
		if (u.search || u.hash || u.username || u.password) {
			throw new RedirectAllowlistError(
				`pattern entries must not carry a query, fragment, or credentials: ${item}`,
			);
		}
		return { kind: 'prefix', origin: u.origin, pathPrefix: u.pathname };
	}
	if (item.includes('*')) {
		throw new RedirectAllowlistError(
			`wildcards are only allowed as a trailing "/*" path segment: ${item}`,
		);
	}
	let u: URL;
	try {
		u = new URL(item);
	} catch {
		throw new RedirectAllowlistError(`not a valid URL: ${item}`);
	}
	// Authority-less URIs (e.g. `com.example.app:/oauth2redirect`) parse but
	// can never complete the flow — the consent POST 400s on the empty host —
	// so reject them at boot rather than at redirect time.
	if (u.hostname === '') {
		throw new RedirectAllowlistError(`redirect URI must include a host: ${item}`);
	}
	return { kind: 'exact', uri: item };
}

// The one entry-matcher shared by both the shipped defaults (source 2) and the
// operator entries (source 3): exact string equality for 'exact', origin plus
// normalized-path-prefix for 'prefix'.
function matchEntry(uri: string, entry: AllowlistEntry): boolean {
	return entry.kind === 'exact'
		? uri === entry.uri
		: matchesPrefix(uri, entry.origin, entry.pathPrefix);
}

// Composes the built-in base policy with the shipped client defaults and the
// operator's allowlist into the predicate handleRegister applies to every
// submitted redirect_uri.
export function buildRedirectPolicy(allowlist: RedirectAllowlist): (uri: string) => boolean {
	const entries = [...SHIPPED_CLIENT_DEFAULTS, ...allowlist];
	return (uri) => isAllowedRedirect(uri) || entries.some((e) => matchEntry(uri, e));
}

function matchesPrefix(uri: string, origin: string, pathPrefix: string): boolean {
	let u: URL;
	try {
		u = new URL(uri);
	} catch {
		return false;
	}
	// Fragments are forbidden in redirect URIs (RFC 6749 §3.1.2); origin pins
	// scheme + host + port, and the parsed pathname is `..`-normalized before
	// the prefix check.
	return (
		u.protocol === 'https:' &&
		u.hash === '' &&
		u.origin === origin &&
		u.pathname.startsWith(pathPrefix)
	);
}
