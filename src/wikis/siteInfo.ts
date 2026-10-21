import type { ToolContext } from '../runtime/context.ts';
import type { WikiIdentity } from './wikiProbe.ts';

export type SiteInfo = WikiIdentity & { server: string; articlepath: string };

// The wiki's identity as its probe last read it, with the configured server and
// article path standing in until the wiki has answered.
export async function resolveSiteInfo(ctx: ToolContext, wikiKey: string): Promise<SiteInfo> {
	const {
		reachable: _reachable,
		extensions: _extensions,
		...identity
	} = await ctx.wikiProbe.inspect(wikiKey);
	const config = ctx.wikis.get(wikiKey);
	return {
		...identity,
		server: identity.server ?? config?.server ?? '',
		articlepath: identity.articlepath ?? config?.articlepath ?? '',
	};
}
