// src/auth/metadata.ts
import { logger } from '../runtime/logger.js';

export interface AsMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	scopes_supported?: string[];
	source: 'well-known' | 'well-known-pathed' | 'synthesized';
	synthesized: boolean;
}

export class MetadataError extends Error {
	constructor(
		public readonly reason: 'unsupported_grant',
		message: string,
	) {
		super(message);
		this.name = 'MetadataError';
	}
}

/**
 * Minimal wiki config slice consumed by this module (and reused by downstream
 * auth modules to avoid importing the full WikiConfig).
 */
export interface WikiSlice {
	server: string;
	scriptpath: string;
}

const TIMEOUT_MS = 5000;

const cache = new Map<string, Promise<AsMetadata>>();

export function _resetMetadataCacheForTesting(): void {
	cache.clear();
}

export function fetchMetadata(wikiKey: string, wiki: WikiSlice): Promise<AsMetadata> {
	const cached = cache.get(wikiKey);
	if (cached) {
		return cached;
	}
	const pending = doFetch(wikiKey, wiki).catch((err: unknown) => {
		cache.delete(wikiKey);
		throw err;
	});
	cache.set(wikiKey, pending);
	return pending;
}

async function doFetch(wikiKey: string, wiki: WikiSlice): Promise<AsMetadata> {
	const started = Date.now();
	const origin = `${wiki.server}/.well-known/oauth-authorization-server`;
	const pathed = `${wiki.server}/.well-known/oauth-authorization-server${wiki.scriptpath}/rest.php/oauth2`;

	const originResp = await tryFetch(origin);
	if (originResp !== undefined) {
		const parsed = parseMetadata(originResp, 'well-known');
		if (parsed !== null) {
			return finalize(wikiKey, started, parsed, wiki);
		}
	}

	const pathedResp = await tryFetch(pathed);
	if (pathedResp !== undefined) {
		const parsed = parseMetadata(pathedResp, 'well-known-pathed');
		if (parsed !== null) {
			return finalize(wikiKey, started, parsed, wiki);
		}
	}

	// Both probes failed or returned malformed docs — synthesise from conventions.
	const synthesized: AsMetadata = {
		issuer: wiki.server,
		authorization_endpoint: `${wiki.server}${wiki.scriptpath}/rest.php/oauth2/authorize`,
		token_endpoint: `${wiki.server}${wiki.scriptpath}/rest.php/oauth2/access_token`,
		source: 'synthesized',
		synthesized: true,
	};
	logger.info('', {
		event: 'oauth_discovery',
		wiki: wikiKey,
		outcome: 'success',
		source: 'synthesized',
		duration_ms: Date.now() - started,
	});
	return synthesized;
}

async function tryFetch(url: string): Promise<unknown> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) {
			return undefined;
		}
		return await res.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse a raw metadata document. Returns `null` when the document is present
 * but missing required fields (caller falls through to next probe / synthesis).
 * Throws `MetadataError` only when `code_challenge_methods_supported` is
 * explicitly declared but does not include `S256` — that is a hard blocker.
 */
function parseMetadata(
	raw: unknown,
	source: 'well-known' | 'well-known-pathed',
): AsMetadata | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON boundary; required fields validated immediately below
	const obj = raw as Record<string, unknown>;
	const auth = obj.authorization_endpoint;
	const tok = obj.token_endpoint;

	// Missing required endpoints → treat as malformed, fall through to synthesis.
	if (typeof auth !== 'string' || typeof tok !== 'string') {
		return null;
	}

	// Explicit declaration without S256 → hard error.
	const methods = obj.code_challenge_methods_supported;
	if (Array.isArray(methods) && !methods.includes('S256')) {
		throw new MetadataError(
			'unsupported_grant',
			'AS does not advertise PKCE S256 in code_challenge_methods_supported',
		);
	}

	return {
		issuer: typeof obj.issuer === 'string' ? obj.issuer : '',
		authorization_endpoint: auth,
		token_endpoint: tok,
		scopes_supported: Array.isArray(obj.scopes_supported)
			? obj.scopes_supported.filter((s): s is string => typeof s === 'string')
			: undefined,
		source,
		synthesized: false,
	};
}

function finalize(wikiKey: string, started: number, md: AsMetadata, wiki: WikiSlice): AsMetadata {
	const issuer = md.issuer || wiki.server;
	logger.info('', {
		event: 'oauth_discovery',
		wiki: wikiKey,
		outcome: 'success',
		source: md.source,
		duration_ms: Date.now() - started,
	});
	return { ...md, issuer };
}
