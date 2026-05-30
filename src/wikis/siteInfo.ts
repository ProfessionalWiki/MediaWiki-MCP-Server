import type { ToolContext } from '../runtime/context.js';
import type { SiteInfo, LicenseInfo } from './siteInfoCache.js';

interface SiteInfoApiResponse {
	query?: {
		general?: { server?: string; articlepath?: string };
		rightsinfo?: { url?: string; text?: string };
	};
}

// MediaWiki's siteinfo.general.server may be protocol-relative ("//host");
// normalize to https, matching the convention in src/transport/ssrfGuard.ts.
function normalizeServer(server: string): string {
	return server.startsWith('//') ? 'https:' + server : server;
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

		const general = response.query?.general;
		if (!general || typeof general.server !== 'string') {
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
			...(license ? { license } : {}),
		};
		ctx.siteInfoCache.set(wikiKey, resolved);
		return resolved;
	} catch {
		return fallback;
	}
}
