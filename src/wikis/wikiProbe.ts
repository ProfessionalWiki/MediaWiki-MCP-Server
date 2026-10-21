import { makeApiRequest } from '../transport/httpFetch.ts';
import type { WikiRegistry } from './wikiRegistry.ts';
import type { MwnProvider } from './mwnProvider.ts';
import type { WikiConfig } from '../config/loadConfig.ts';
import { normalizeServer } from './normalizeServer.ts';
import { normalizeArticlePath } from './articlePath.ts';
import { withCallBounds } from './abortableMwn.ts';
import { errorMessage } from '../errors/errorMessage.ts';
import { logger } from '../runtime/logger.ts';
import { monotonicNow } from '../runtime/clock.ts';
import { callDeadline } from '../runtime/callDeadline.ts';

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
	/** The article path, as `normalizeArticlePath` keeps it; absent if siteinfo omitted it. */
	articlepath?: string;
	/** The wiki's content language ($wgLanguageCode). */
	lang?: string;
	license?: LicenseInfo;
	/**
	 * Namespace IDs the wiki counts as content ($wgContentNamespaces), ascending;
	 * absent when siteinfo reported no namespace map.
	 */
	contentNamespaces?: readonly number[];
	/**
	 * SPARQL endpoint of the query service backing this wiki's Wikibase
	 * repository. Published in siteinfo as `wikibase-sparql` by a repository
	 * whose `sparqlEndpoint` setting is set; absent on every other wiki.
	 */
	sparqlEndpoint?: string;
}

export type LicenseInfo = { url: string; title: string };

/**
 * Probes a wiki's siteinfo once, caches it (1 h on success, 60 s on failure),
 * and answers reachability, extension, and identity questions from that
 * snapshot: the one siteinfo source, which extension gating, list-wikis, links,
 * search scope, the content language and the wiki resources all read. The
 * probe is anonymous, except for a wiki that keeps anonymous users from
 * reading, which it asks through the wiki's own session.
 */
export interface WikiProbe {
	/**
	 * Per-wiki snapshot. `reachable` is false when the latest probe failed, in
	 * which case `extensions` is empty and the identity fields are those the
	 * last successful probe read, absent if none has succeeded.
	 */
	inspect(wikiKey: string): Promise<WikiInspection>;
	invalidate(wikiKey: string): void;
}

export type WikiInspection = { reachable: boolean; extensions: ReadonlySet<string> } & WikiIdentity;

/** A siteinfo `extensions` entry, as MediaWiki reports it. */
export type SiteinfoExtension = { name?: string };

/** Siteinfo `rightsinfo`: empty strings on a wiki without a license. */
export type SiteinfoRights = { url?: string; text?: string };

interface SiteInfoResponse {
	query?: {
		extensions?: SiteinfoExtension[];
		general?: {
			server?: string;
			articlepath?: string;
			lang?: string;
			'wikibase-sparql'?: string;
		};
		rightsinfo?: SiteinfoRights;
		namespaces?: Record<string, { id?: number; content?: boolean }>;
	};
	error?: { code?: string };
}

const SITEINFO_QUERY = {
	action: 'query',
	meta: 'siteinfo',
	siprop: 'extensions|general|namespaces|rightsinfo',
	format: 'json',
	formatversion: '2',
};

type CacheEntry = {
	reachable: boolean;
	extensions: ReadonlySet<string>;
	identity: WikiIdentity;
	expiresAt: number;
};

export class WikiProbeImpl implements WikiProbe {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly sessions: MwnProvider,
		private readonly now: () => number = monotonicNow,
	) {}

	public async inspect(wikiKey: string): Promise<WikiInspection> {
		const { reachable, extensions, identity } = await this.resolveEntry(wikiKey);
		return { reachable, extensions, ...identity };
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

	// Never throws — a failure is cached as an unreachable entry with a
	// TTL_FAILURE_MS backoff. Callers (notably reconcile's rule predicates)
	// depend on this totality to keep Promise.all from rejecting.
	private async probe(wikiKey: string): Promise<CacheEntry> {
		const config = this.wikis.get(wikiKey);
		if (!config) {
			return this.recordFailure(wikiKey);
		}

		try {
			const data = await this.readSiteInfo(wikiKey, config);
			// Extensions gate tool visibility, so a malformed list is a hard failure.
			const list = data.query?.extensions;
			if (!Array.isArray(list)) {
				throw new Error('Malformed siteinfo extensions response');
			}

			const entry: CacheEntry = {
				reachable: true,
				extensions: new Set(extensionNames(list)),
				identity: readIdentity(data),
				expiresAt: this.now() + TTL_SUCCESS_MS,
			};
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (error) {
			logger.warning('Wiki siteinfo probe failed', {
				wikiKey,
				error: errorMessage(error),
			});
			return this.recordFailure(wikiKey);
		}
	}

	// A failed probe keeps the identity it last read, so links stay public through
	// a blip while the extension tools follow the wiki's current state.
	private recordFailure(wikiKey: string): CacheEntry {
		const failed: CacheEntry = {
			reachable: false,
			extensions: new Set(),
			identity: this.cache.get(wikiKey)?.identity ?? {},
			expiresAt: this.now() + TTL_FAILURE_MS,
		};
		this.cache.set(wikiKey, failed);
		return failed;
	}

	// A wiki that keeps anonymous users from reading refuses siteinfo too, so it
	// is asked through its own session: at once when configured private, otherwise
	// once the anonymous probe is refused. Only then, so that a public wiki's
	// credentials, which may run a command to resolve, are left alone.
	private async readSiteInfo(
		wikiKey: string,
		config: Readonly<WikiConfig>,
	): Promise<SiteInfoResponse> {
		if (config.private !== true) {
			const data = await makeApiRequest<SiteInfoResponse>(
				`${config.server}${config.scriptpath}/api.php`,
				SITEINFO_QUERY,
				{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
			);
			if (data.error?.code !== 'readapidenied') {
				return data;
			}
		}
		// Bounded on a budget of its own rather than the caller's, since the
		// answer is shared with every caller that joins it.
		const session = withCallBounds(
			await this.sessions.get(wikiKey),
			callDeadline(PROBE_TIMEOUT_MS, 'connecting'),
		);
		return session.request(SITEINFO_QUERY);
	}
}

export function extensionNames(list: readonly SiteinfoExtension[]): string[] {
	return list
		.map((extension) => extension.name)
		.filter((name): name is string => typeof name === 'string' && name !== '');
}

export function licenseOf(rights: SiteinfoRights | undefined): LicenseInfo | undefined {
	return rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;
}

// General, rights and namespaces are best-effort identity: a field siteinfo
// omits leaves the snapshot without it.
function readIdentity(data: SiteInfoResponse): WikiIdentity {
	const general = data.query?.general;
	const license = licenseOf(data.query?.rightsinfo);
	const contentNamespaces = readContentNamespaces(data.query?.namespaces);
	return {
		...(typeof general?.server === 'string' && general.server !== ''
			? { server: normalizeServer(general.server) }
			: {}),
		...(typeof general?.articlepath === 'string'
			? { articlepath: normalizeArticlePath(general.articlepath) }
			: {}),
		...(typeof general?.lang === 'string' && general.lang !== '' ? { lang: general.lang } : {}),
		...(license !== undefined ? { license } : {}),
		...(contentNamespaces.length > 0 ? { contentNamespaces } : {}),
		...(typeof general?.['wikibase-sparql'] === 'string' && general['wikibase-sparql'] !== ''
			? { sparqlEndpoint: general['wikibase-sparql'] }
			: {}),
	};
}

// MediaWiki always flags the main namespace as content, so an empty result means
// the wiki reported no namespace map rather than that it holds no content. The
// negative namespaces (Media, Special) are dropped because the search API
// refuses them, and one refused value costs the whole scope.
function readContentNamespaces(
	namespaces: Record<string, { id?: number; content?: boolean }> | undefined,
): number[] {
	if (!namespaces) {
		return [];
	}

	const ids = new Set<number>();
	for (const entry of Object.values(namespaces)) {
		if (entry.content === true && typeof entry.id === 'number' && entry.id >= 0) {
			ids.add(entry.id);
		}
	}
	return [...ids].sort((a, b) => a - b);
}
