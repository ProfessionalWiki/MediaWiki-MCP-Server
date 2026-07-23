import type { ToolContext } from '../runtime/context.js';
import { resolveSiteInfo } from './siteInfo.js';

export async function buildPageUrl(ctx: ToolContext, title: string): Promise<string> {
	const { key } = ctx.activeWiki.get();
	const { server, articlepath } = await resolveSiteInfo(ctx, key);
	// MediaWiki convention: spaces become underscores. encodeURI preserves
	// '/' (subpages) and ':' (namespace prefixes) while encoding spaces and
	// non-ASCII characters. Characters disallowed in MW titles ('#', '?',
	// '|', '[', ']', etc.) cannot reach this function via a real page title.
	return `${server}${articlepath}/${encodeURI(title.replace(/ /g, '_'))}`;
}

export function formatEditComment(ctx: ToolContext, tool: string, comment?: string): string {
	if (ctx.activeWiki.get().config.attributeEdits === false) {
		return comment ?? '';
	}
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (!comment) {
		return `Automated edit ${suffix}`;
	}
	return `${comment} ${suffix}`;
}
