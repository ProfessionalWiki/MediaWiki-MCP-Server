import type { ToolContext } from '../runtime/context.ts';
import type { SiteInfo, LicenseInfo, SiteInfoCache } from './siteInfoCache.ts';
import { normalizeServer } from './normalizeServer.ts';
import { withoutRequestSignal } from '../runtime/requestContext.ts';

interface SiteInfoApiResponse {
	query?: {
		general?: { server?: string; articlepath?: string; lang?: string };
		rightsinfo?: { url?: string; text?: string };
	};
}

// In-flight resolutions, so concurrent cold-cache misses for the same wiki
// (e.g. a get-pages or search-page batch building one URL per result) share a
// single siteinfo request instead of issuing one each. Mirrors the inflight
// idiom in wikiProbe.ts. Keyed by the cache instance via a WeakMap so
// each ToolContext — and each test — is isolated, and entries are dropped with
// their cache rather than leaking.
const inflightByCache = new WeakMap<SiteInfoCache, Map<string, Promise<SiteInfo>>>();

async function fetchSiteInfo(ctx: ToolContext, wikiKey: string): Promise<SiteInfo> {
	// config.server/articlepath are required strings on a known wiki, so the
	// '' sentinels only apply to an unknown wikiKey. The sole production caller
	// (the wikis resource) early-returns on unknown keys before reaching here,
	// so an empty-string base never escapes today; it's a defensive default.
	const config = ctx.wikis.get(wikiKey);
	const fallback: SiteInfo = {
		server: config?.server ?? '',
		articlepath: config?.articlepath ?? '',
	};

	try {
		const mwn = await ctx.mwn(wikiKey);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn.request returns ApiResponse; narrow to the siteinfo shape we requested
		const response = (await mwn.request({
			action: 'query',
			meta: 'siteinfo',
			siprop: 'general|rightsinfo',
			formatversion: '2',
		})) as SiteInfoApiResponse;

		// An empty server would yield relative links, so treat it as a miss and
		// fall back to the configured value.
		const general = response.query?.general;
		if (!general || typeof general.server !== 'string' || general.server === '') {
			return fallback;
		}

		const rights = response.query?.rightsinfo;
		const license: LicenseInfo | undefined =
			rights?.url && rights.text ? { url: rights.url, title: rights.text } : undefined;

		const resolved: SiteInfo = {
			server: normalizeServer(general.server),
			articlepath:
				typeof general.articlepath === 'string'
					? general.articlepath.replace('/$1', '')
					: fallback.articlepath,
			...(typeof general.lang === 'string' && general.lang !== '' ? { lang: general.lang } : {}),
			...(license ? { license } : {}),
		};
		ctx.siteInfoCache.set(wikiKey, resolved);
		return resolved;
	} catch {
		return fallback;
	}
}

// Resolves the wiki's own public base (and license) from meta=siteinfo,
// cached per wiki. Never throws: any failure falls back to the configured
// server/articlepath without caching, so a transiently-unreachable wiki is
// retried on the next call.
export async function resolveSiteInfo(ctx: ToolContext, wikiKey: string): Promise<SiteInfo> {
	const cached = ctx.siteInfoCache.get(wikiKey);
	if (cached) {
		return cached;
	}

	let inflight = inflightByCache.get(ctx.siteInfoCache);
	if (!inflight) {
		inflight = new Map();
		inflightByCache.set(ctx.siteInfoCache, inflight);
	}
	const existing = inflight.get(wikiKey);
	if (existing) {
		return existing;
	}

	// Detached from the calling request's cancellation: this promise is handed
	// to every concurrent caller, so honouring the first caller's cancellation
	// would drop all the others onto the fallback and silently degrade their
	// page URLs. The extra siteinfo request an abandoned caller leaves behind is
	// one cheap call, and it populates the cache for everyone.
	const promise = withoutRequestSignal(() => fetchSiteInfo(ctx, wikiKey)).finally(() => {
		inflight.delete(wikiKey);
	});
	inflight.set(wikiKey, promise);
	return promise;
}
