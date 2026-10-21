import type { ToolContext } from '../runtime/context.ts';
import { resolveSiteInfo } from './siteInfo.ts';

export async function buildPageUrl(ctx: ToolContext, title: string): Promise<string> {
	const { key } = ctx.activeWiki.get();
	const { server, articlepath } = await resolveSiteInfo(ctx, key);
	// The article path arrives with a trailing '/$1' stripped, or as MediaWiki's
	// own pattern when the placeholder sits elsewhere, as in '/index.php?title=$1'.
	const pattern = articlepath.includes('$1') ? articlepath : `${articlepath}/$1`;
	// A replacer function, since a title may contain '$$' or "$'".
	return server + pattern.replace('$1', () => encodeTitle(title));
}

// Mirrors MediaWiki's wfUrlencode: the encoded title is safe in a path or a
// query value, and keeps ';@$,/:' readable.
function encodeTitle(title: string): string {
	return encodeURIComponent(title.replace(/ /g, '_')).replace(
		/%(?:3B|40|24|2C|2F|3A)/g,
		decodeURIComponent,
	);
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
