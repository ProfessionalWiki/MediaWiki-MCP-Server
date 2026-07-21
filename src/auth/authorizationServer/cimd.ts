import type { ClientRecord } from './proxyStore.js';
import type { CimdFetchResult } from '../../transport/cimdFetch.js';

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
			if (entry.includes('*')) {
				throw new CimdValidationError(`CIMD host entry must not contain a wildcard: ${entry}`);
			}
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
	const allowed = new Set<string>([
		...SHIPPED_CIMD_HOSTS,
		...operatorHosts.map((h) => h.toLowerCase()),
	]);
	return (host) => allowed.has(host.toLowerCase());
}

export interface CimdDocument {
	client_id: string;
	client_name: string;
	redirect_uris: string[];
}

// Validates a parsed metadata document against the MCP required-field set plus the
// IETF self-reference rule. Self-reference is a SIMPLE STRING comparison with NO
// normalization: `https://h/c` and `https://h:443/c` are distinct. The token auth
// method is intentionally NOT read — every CIMD client is treated as public/PKCE,
// so a document offering private_key_jwt is accepted (tolerant), never rejected.
export function validateCimdDocument(clientId: string, raw: unknown): CimdDocument {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new CimdValidationError('metadata document is not a JSON object');
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CIMD document is untyped JSON; fields are validated individually below
	const d = raw as Record<string, unknown>;
	if (d.client_id !== clientId) {
		throw new CimdValidationError('document client_id does not match the fetched URL');
	}
	if (typeof d.client_name !== 'string' || d.client_name.trim() === '') {
		throw new CimdValidationError('document is missing a client_name');
	}
	if (
		!Array.isArray(d.redirect_uris) ||
		d.redirect_uris.length === 0 ||
		!d.redirect_uris.every((u): u is string => typeof u === 'string')
	) {
		throw new CimdValidationError('document is missing a non-empty redirect_uris array');
	}
	return { client_id: clientId, client_name: d.client_name, redirect_uris: [...d.redirect_uris] };
}

// A CIMD client is a public (PKCE) client. It is never stored in ProxyStore, so
// createdAt is unused here and set to 0.
export function synthesizeClientRecord(clientId: string, doc: CimdDocument): ClientRecord {
	return {
		clientId,
		redirectUris: doc.redirect_uris,
		scopes: [],
		name: doc.client_name,
		createdAt: 0,
	};
}

const CIMD_TTL_MIN_MS = 5 * 60 * 1000;
const CIMD_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const CIMD_TTL_DEFAULT_MS = 60 * 60 * 1000;
const CIMD_CACHE_MAX_ENTRIES = 1000;

// Honor Cache-Control max-age, clamped to [5m, 24h]; default 1h when absent or
// unparseable. The clamp stops a max-age=0 doc from forcing a fetch every /authorize
// and a very long max-age from pinning a stale redirect list past a day.
export function cimdTtlMs(cacheControl: string | null): number {
	const m = cacheControl ? /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl) : null;
	if (!m) {
		return CIMD_TTL_DEFAULT_MS;
	}
	const ms = Number(m[1]) * 1000;
	return Math.min(Math.max(ms, CIMD_TTL_MIN_MS), CIMD_TTL_MAX_MS);
}

export type CimdResolveResult = { ok: true; client: ClientRecord } | { ok: false; reason: string };

// Resolves a URL client_id into a public ClientRecord, or a reason string. The
// fetcher is injected (production passes fetchCimdDocument); the cache is per-resolver
// and in-memory. Failures are never cached. The host allowlist gate runs BEFORE the
// fetch, so only trusted hosts are ever contacted (the SSRF/DoS bound).
export class CimdResolver {
	private cache = new Map<string, { record: ClientRecord; expiresAt: number }>();

	public constructor(
		private isHostAllowed: (host: string) => boolean,
		private fetcher: (url: string) => Promise<CimdFetchResult>,
		private now: () => number = Date.now,
		private maxEntries: number = CIMD_CACHE_MAX_ENTRIES,
	) {}

	public async resolve(clientId: string): Promise<CimdResolveResult> {
		let url: URL;
		try {
			url = validateClientIdUrl(clientId);
		} catch (e) {
			return { ok: false, reason: e instanceof Error ? e.message : 'invalid client_id URL' };
		}
		if (!this.isHostAllowed(url.host)) {
			return { ok: false, reason: `client_id host is not a trusted CIMD host: ${url.host}` };
		}
		const cached = this.cache.get(clientId);
		if (cached && cached.expiresAt > this.now()) {
			return { ok: true, client: cached.record };
		}

		let result: CimdFetchResult;
		try {
			result = await this.fetcher(clientId);
		} catch (e) {
			return {
				ok: false,
				reason: e instanceof Error ? e.message : 'could not fetch CIMD document',
			};
		}
		if (result.status !== 200) {
			return { ok: false, reason: `CIMD document returned HTTP ${result.status}` };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.body);
		} catch {
			return { ok: false, reason: 'CIMD document is not valid JSON' };
		}
		let record: ClientRecord;
		try {
			record = synthesizeClientRecord(clientId, validateCimdDocument(clientId, parsed));
		} catch (e) {
			return { ok: false, reason: e instanceof Error ? e.message : 'invalid CIMD document' };
		}

		this.evictIfFull();
		this.cache.set(clientId, { record, expiresAt: this.now() + cimdTtlMs(result.cacheControl) });
		return { ok: true, client: record };
	}

	private evictIfFull(): void {
		while (this.cache.size >= this.maxEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cache.delete(oldest);
		}
	}
}
