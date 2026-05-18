import { makeApiRequest } from '../transport/httpFetch.js';
import type { WikiRegistry } from './wikiRegistry.js';
import { errorMessage } from '../errors/isErrnoException.js';
import { logger } from '../runtime/logger.js';

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 hour
const TTL_FAILURE_MS = 60 * 1000; // 60 seconds

// Bound the siteinfo probe so a TCP-level stall on an unreachable wiki fails
// fast instead of hanging forever. This matters because the probe fans out
// across EVERY configured wiki — startup reconcile() probes them all, and the
// list-wikis tool re-probes them all on each call. Without a timeout, one
// blackholed wiki would hang every list-wikis call and leave extension tools
// permanently un-reconciled. A timed-out probe aborts the fetch with an abort
// error, which lands in probe()'s catch and resolves as a `failed` entry.
const PROBE_TIMEOUT_MS = 5_000;

export interface ExtensionDetector {
	has(wikiKey: string, extensionName: string): Promise<boolean>;
	/**
	 * True when the wiki advertises ANY of the given extension names. Useful for
	 * extensions that ship under multiple names — e.g. Cargo is rebranded as
	 * `LIBRARIAN` on wiki.gg-hosted wikis (Helldivers, Terraria, Ark, etc.).
	 */
	hasAny(wikiKey: string, extensionNames: readonly string[]): Promise<boolean>;
	/**
	 * Per-wiki snapshot for capability reporting. `reachable` is false when the
	 * siteinfo probe failed, in which case `extensions` is empty. Shares the
	 * same probe cache as has()/hasAny().
	 */
	inspect(wikiKey: string): Promise<{ reachable: boolean; extensions: ReadonlySet<string> }>;
	invalidate(wikiKey: string): void;
}

interface ExtensionsResponse {
	query?: { extensions?: { name?: string }[] };
}

type CacheEntry =
	| { kind: 'success'; extensions: Set<string>; expiresAt: number }
	| { kind: 'failed'; expiresAt: number };

export class ExtensionDetectorImpl implements ExtensionDetector {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly now: () => number = () => Date.now(),
	) {}

	public async has(wikiKey: string, extensionName: string): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		return entry.extensions.has(extensionName);
	}

	public async hasAny(wikiKey: string, extensionNames: readonly string[]): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		for (const name of extensionNames) {
			if (entry.extensions.has(name)) {
				return true;
			}
		}
		return false;
	}

	public async inspect(
		wikiKey: string,
	): Promise<{ reachable: boolean; extensions: ReadonlySet<string> }> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return { reachable: false, extensions: new Set() };
		}
		return { reachable: true, extensions: entry.extensions };
	}

	public invalidate(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}

	private async resolveEntry(wikiKey: string): Promise<CacheEntry> {
		const cached = this.cache.get(wikiKey);
		if (cached && cached.expiresAt > this.now()) {
			return cached;
		}

		const inflight = this.inflight.get(wikiKey);
		if (inflight) {
			return inflight;
		}

		const probe = this.probe(wikiKey).finally(() => {
			this.inflight.delete(wikiKey);
		});
		this.inflight.set(wikiKey, probe);
		return probe;
	}

	// Never throws — failures are caught and surfaced as `failed` cache entries
	// with a TTL_FAILURE_MS backoff. has() callers (notably reconcile's rule
	// predicates) depend on this totality to keep Promise.all from rejecting.
	private async probe(wikiKey: string): Promise<CacheEntry> {
		const config = this.wikis.get(wikiKey);
		if (!config) {
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}

		const apiUrl = `${config.server}${config.scriptpath}/api.php`;
		try {
			const data = await makeApiRequest<ExtensionsResponse>(
				apiUrl,
				{
					action: 'query',
					meta: 'siteinfo',
					siprop: 'extensions',
					format: 'json',
				},
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);
			const list = data.query?.extensions;
			if (!Array.isArray(list)) {
				throw new Error('Malformed siteinfo extensions response');
			}
			const names = new Set<string>();
			for (const ext of list) {
				if (typeof ext.name === 'string' && ext.name !== '') {
					names.add(ext.name);
				}
			}
			const entry: CacheEntry = {
				kind: 'success',
				extensions: names,
				expiresAt: this.now() + TTL_SUCCESS_MS,
			};
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (error) {
			logger.warning('Extension probe failed', {
				wikiKey,
				error: errorMessage(error),
			});
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}
	}
}
