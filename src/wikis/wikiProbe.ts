import { makeApiRequest } from '../transport/httpFetch.js';
import type { WikiRegistry } from './wikiRegistry.js';
import type { LicenseInfo } from './siteInfoCache.js';
import { normalizeServer } from './normalizeServer.js';
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

/** A wiki's public identity, read from siteinfo on a successful probe. */
export interface WikiIdentity {
	/** Public server base, normalized to https; absent if siteinfo omitted it. */
	server?: string;
	/** Article path with the `/$1` placeholder stripped; absent if omitted. */
	articlepath?: string;
	/** Content license from rightsinfo; absent unless both url and title exist. */
	license?: LicenseInfo;
}

/**
 * Anonymously probes a wiki's public siteinfo once, caches it (1 h on success,
 * 60 s on failure), and answers reachability, extension, and public-identity
 * questions from that snapshot. A single request fetches everything, so
 * gating, capability reporting, and list-wikis all share one network round-trip
 * per wiki without authenticating.
 */
export interface WikiProbe {
	hasExtension(wikiKey: string, extensionName: string): Promise<boolean>;
	/**
	 * True when the wiki advertises ANY of the given extension names. Useful for
	 * extensions that ship under multiple names — e.g. Cargo is rebranded as
	 * `LIBRARIAN` on wiki.gg-hosted wikis (Helldivers, Terraria, Ark, etc.).
	 */
	hasAnyExtension(wikiKey: string, extensionNames: readonly string[]): Promise<boolean>;
	/**
	 * Per-wiki snapshot for capability and discovery reporting. `reachable` is
	 * false when the siteinfo probe failed, in which case `extensions` is empty
	 * and the identity fields are absent. Shares the same probe cache as
	 * hasExtension()/hasAnyExtension().
	 */
	inspect(
		wikiKey: string,
	): Promise<{ reachable: boolean; extensions: ReadonlySet<string> } & WikiIdentity>;
	invalidate(wikiKey: string): void;
}

interface SiteInfoResponse {
	query?: {
		extensions?: { name?: string }[];
		general?: { server?: string; articlepath?: string };
		rightsinfo?: { url?: string; text?: string };
	};
}

type CacheEntry =
	| ({ kind: 'success'; extensions: Set<string>; expiresAt: number } & WikiIdentity)
	| { kind: 'failed'; expiresAt: number };

export class WikiProbeImpl implements WikiProbe {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly now: () => number = () => Date.now(),
	) {}

	public async hasExtension(wikiKey: string, extensionName: string): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		return entry.extensions.has(extensionName);
	}

	public async hasAnyExtension(
		wikiKey: string,
		extensionNames: readonly string[],
	): Promise<boolean> {
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
	): Promise<{ reachable: boolean; extensions: ReadonlySet<string> } & WikiIdentity> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return { reachable: false, extensions: new Set() };
		}
		return {
			reachable: true,
			extensions: entry.extensions,
			...(entry.server !== undefined ? { server: entry.server } : {}),
			...(entry.articlepath !== undefined ? { articlepath: entry.articlepath } : {}),
			...(entry.license !== undefined ? { license: entry.license } : {}),
		};
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
	// with a TTL_FAILURE_MS backoff. Callers (notably reconcile's rule
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
			const data = await makeApiRequest<SiteInfoResponse>(
				apiUrl,
				{
					action: 'query',
					meta: 'siteinfo',
					siprop: 'extensions|general|rightsinfo',
					format: 'json',
				},
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);
			// Extensions gate tool visibility, so a malformed list is a hard failure.
			// General and rightsinfo are best-effort public identity: absent fields
			// simply leave the corresponding snapshot field undefined.
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

			const general = data.query?.general;
			const server =
				typeof general?.server === 'string' && general.server !== ''
					? normalizeServer(general.server)
					: undefined;
			const articlepath =
				typeof general?.articlepath === 'string'
					? general.articlepath.replace('/$1', '')
					: undefined;
			const rights = data.query?.rightsinfo;
			const license: LicenseInfo | undefined =
				rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;

			const entry: CacheEntry = {
				kind: 'success',
				extensions: names,
				expiresAt: this.now() + TTL_SUCCESS_MS,
				...(server !== undefined ? { server } : {}),
				...(articlepath !== undefined ? { articlepath } : {}),
				...(license !== undefined ? { license } : {}),
			};
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (error) {
			logger.warning('Wiki siteinfo probe failed', {
				wikiKey,
				error: errorMessage(error),
			});
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}
	}
}
