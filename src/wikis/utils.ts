import type { ApiDeleteResponse, ApiMoveResponse, ApiUndeleteResponse } from 'mwn';
import type { ApiDeleteParams, ApiMoveParams, ApiUndeleteParams } from 'types-mediawiki-api';
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
	if (ctx.activeWiki.get().config.attributeEdits === false) {
		return comment === '' ? undefined : comment;
	}
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (!comment) {
		return `Automated edit ${suffix}`;
	}
	return `${comment} ${suffix}`;
}

/**
 * mwn's page-write methods, with the reason typed as mwn actually treats it.
 * Each forwards the argument into the action API's `reason` parameter and drops
 * the parameter when the value is `undefined`, which is the only way to send no
 * reason at all; mwn's own documentation marks the argument optional while its
 * type declaration does not. Assign an `Mwn` to this to omit a reason without
 * asserting away the `undefined` that has to survive.
 */
export interface PageWrites {
	delete(
		title: string,
		reason: string | undefined,
		options?: ApiDeleteParams,
	): Promise<ApiDeleteResponse>;
	undelete(
		title: string,
		reason: string | undefined,
		options?: ApiUndeleteParams,
	): Promise<ApiUndeleteResponse>;
	move(
		fromTitle: string,
		toTitle: string,
		reason: string | undefined,
		options?: ApiMoveParams,
	): Promise<ApiMoveResponse>;
}
