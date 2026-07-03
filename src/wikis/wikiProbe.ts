import { makeApiRequest } from '../transport/httpFetch.js';
import type { WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from './wikiRegistry.js';
import type { MwnProvider } from './mwnProvider.js';
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
 * Probes a wiki's siteinfo once, caches it (1 h on success, 60 s on failure),
 * and answers reachability, extension, and public-identity questions from that
 * snapshot. A single request fetches everything, so gating, capability
 * reporting, and list-wikis all share one network round-trip per wiki without
 * authenticating.
 *
 * The probe is anonymous by default. Wikis configured `private: true`
 * (`$wgGroupPermissions['*']['read'] = false`) always deny anonymous reads,
 * so the probe skips straight to the wiki's authenticated `mwn` session (the
 * same one tool calls use) instead of wasting a round-trip. A wiki that
 * denies anonymous reads WITHOUT declaring `private` gets the same
 * authenticated retry reactively, triggered by MediaWiki's
 * `{error:{code:'readapidenied',...}}` envelope rather than treating it as a
 * malformed response. Either way, this deliberately does not require or
 * suggest opening up anonymous read on the wiki — it only uses credentials
 * the operator already configured.
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
	error?: { code?: string; info?: string };
}

interface ParsedSiteInfo extends WikiIdentity {
	extensions: Set<string>;
}

function hasCredentials(config: Readonly<WikiConfig>): boolean {
	return Boolean(config.token) || Boolean(config.username && config.password);
}

// Throws 'Malformed siteinfo extensions response' when query.extensions isn't
// an array — the caller decides whether that's a real shape problem or the
// caller passed in an {error:...} envelope that never had a query at all.
function parseSiteInfo(data: SiteInfoResponse): ParsedSiteInfo {
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
		typeof general?.articlepath === 'string' ? general.articlepath.replace('/$1', '') : undefined;
	const rights = data.query?.rightsinfo;
	const license: LicenseInfo | undefined =
		rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;

	return {
		extensions: names,
		...(server !== undefined ? { server } : {}),
		...(articlepath !== undefined ? { articlepath } : {}),
		...(license !== undefined ? { license } : {}),
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
		private readonly mwnProvider?: MwnProvider,
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

		const siprop = 'extensions|general|rightsinfo';

		// `private: true` means the wiki always denies anonymous reads
		// ($wgGroupPermissions['*']['read'] = false) — skip the doomed
		// anonymous round-trip and probe authenticated directly.
		if (config.private === true) {
			return this.probeAuthenticated(wikiKey, config, siprop);
		}

		const apiUrl = `${config.server}${config.scriptpath}/api.php`;
		try {
			const data = await makeApiRequest<SiteInfoResponse>(
				apiUrl,
				{ action: 'query', meta: 'siteinfo', siprop, format: 'json' },
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);

			// A well-formed MediaWiki API error (e.g. readapidenied on a wiki that
			// requires read permission even anonymously) is not a malformed
			// response — it's a permission denial. Retry authenticated rather than
			// suggesting the wiki open up anonymous read.
			if (data.error) {
				return this.probeAuthenticated(wikiKey, config, siprop, data.error);
			}

			const entry = this.toSuccessEntry(parseSiteInfo(data));
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

	private toSuccessEntry(parsed: ParsedSiteInfo): CacheEntry {
		return {
			kind: 'success',
			extensions: parsed.extensions,
			expiresAt: this.now() + TTL_SUCCESS_MS,
			...(parsed.server !== undefined ? { server: parsed.server } : {}),
			...(parsed.articlepath !== undefined ? { articlepath: parsed.articlepath } : {}),
			...(parsed.license !== undefined ? { license: parsed.license } : {}),
		};
	}

	// Reached either because config.private skipped the anonymous attempt
	// (anonymousError undefined), or because an anonymous probe that wasn't
	// declared private got a well-formed API error back anyway — a wiki
	// locked down without the config flag set (anonymousError present).
	// Not reached for network/shape failures; those go through probe()'s own
	// catch. Skips the retry entirely when no credentials are configured, so
	// a wiki with no bot account doesn't pay for a doomed round-trip.
	private async probeAuthenticated(
		wikiKey: string,
		config: Readonly<WikiConfig>,
		siprop: string,
		anonymousError?: { code?: string; info?: string },
	): Promise<CacheEntry> {
		const anonymousReason = anonymousError
			? (anonymousError.code ?? anonymousError.info ?? 'unknown API error')
			: undefined;

		if (!this.mwnProvider || !hasCredentials(config)) {
			logger.warning(
				anonymousReason
					? 'Wiki siteinfo probe denied for anonymous access'
					: 'Wiki is configured private but has no credentials for an authenticated siteinfo probe',
				{ wikiKey, ...(anonymousReason ? { error: anonymousReason } : {}) },
			);
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}

		try {
			const mwn = await this.mwnProvider.get(wikiKey);
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn.request() resolves the raw API body; trusted JSON envelope at this boundary, same as makeApiRequest()
			const authData = (await mwn.request({
				action: 'query',
				meta: 'siteinfo',
				siprop,
			})) as SiteInfoResponse;
			const entry = this.toSuccessEntry(parseSiteInfo(authData));
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (authError) {
			logger.warning(
				anonymousReason
					? 'Wiki siteinfo probe denied for anonymous access; authenticated retry failed'
					: 'Authenticated siteinfo probe failed for private wiki',
				{
					wikiKey,
					...(anonymousReason ? { anonymousError: anonymousReason } : {}),
					authError: errorMessage(authError),
				},
			);
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}
	}
}
