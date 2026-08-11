import type { ToolContext } from '../runtime/context.ts';
import { resolveSiteInfo } from './siteInfo.ts';

export async function buildPageUrl(ctx: ToolContext, title: string): Promise<string> {
	const { key } = ctx.activeWiki.get();
	const { server, articlepath } = await resolveSiteInfo(ctx, key);
	// MediaWiki convention: spaces become underscores. encodeURI preserves
	// '/' (subpages) and ':' (namespace prefixes) while encoding spaces and
	// non-ASCII characters. Characters disallowed in MW titles ('#', '?',
	// '|', '[', ']', etc.) cannot reach this function via a real page title.
	return `${server}${articlepath}/${encodeURI(title.replace(/ /g, '_'))}`;
}

/**
 * The edit summary a write should carry, attributed to the tool making it, or
 * `undefined` when there is none: a wiki that has turned attribution off and a
 * caller that gave no comment. An absent summary is not an empty one — MediaWiki
 * writes its own deletion reason only when the parameter arrives absent — so the
 * two cases must stay distinct all the way to the wire.
 */
export function formatEditComment(
	ctx: ToolContext,
	tool: string,
	comment?: string,
): string | undefined {
	const given = comment === '' ? undefined : comment;
	if (ctx.activeWiki.get().config.attributeEdits === false) {
		return given;
	}
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (given === undefined) {
		return `Automated edit ${suffix}`;
	}
	return `${given} ${suffix}`;
}
