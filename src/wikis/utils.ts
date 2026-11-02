import { Mwn } from 'mwn';
import type { ToolContext } from '../runtime/context.ts';
import { articlePathPattern } from './articlePath.ts';
import { resolveSiteInfo } from './siteInfo.ts';

export async function buildPageUrl(ctx: ToolContext, title: string): Promise<string> {
	const { server, articlepath } = await resolveSiteInfo(ctx, ctx.wiki.key);
	// A replacer function, since a title may contain '$$'.
	return (
		server + articlePathPattern(articlepath).replace('$1', () => Mwn.util.wikiUrlencode(title))
	);
}

/**
 * Whether a write should ask MediaWiki to mark the edit as a bot edit.
 *
 * The call's own `bot` input wins when it is given, in both directions, so a
 * single edit can opt out of a wiki that flags everything, or opt in on one that
 * flags nothing. When the call says nothing, the wiki's `bot` setting decides,
 * and without one the answer is false, which is the behaviour before the setting
 * existed. Whether the flag then takes effect is up to the wiki: it needs the
 * `bot` right, and an account without it saves the edit unflagged.
 */
export function resolveBotFlag(ctx: ToolContext, bot?: boolean): boolean {
	return bot ?? ctx.wiki.config.bot === true;
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
	if (ctx.wiki.config.attributeEdits === false) {
		return given;
	}
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (given === undefined) {
		return `Automated edit ${suffix}`;
	}
	return `${given} ${suffix}`;
}
