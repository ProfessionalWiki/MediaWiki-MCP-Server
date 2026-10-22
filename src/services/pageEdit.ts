import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl } from '../wikis/utils.ts';

/** The page a write lands on, or one of its sections as numbered at `latestId`. */
export interface EditTarget {
	readonly title: string;
	readonly section?: number;
	readonly latestId?: number;
}

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

export async function submitPageEdit(
	ctx: ToolContext,
	mwn: Mwn,
	failureVerb: string,
	params: Record<string, unknown>,
	{ title, bot }: { readonly title: string; readonly bot?: boolean },
): Promise<CallToolResult> {
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await ctx.edit.submit(mwn, params)) as { edit?: ApiEditResponse } | undefined;
	const edit = response?.edit;
	if (!edit || edit.result !== 'Success') {
		return ctx.format.error(
			'upstream_failure',
			`Failed to ${failureVerb}: ${JSON.stringify(edit ?? response)}`,
		);
	}
	const resolvedTitle = edit.title ?? title;
	return ctx.format.ok({
		pageId: edit.pageid,
		title: resolvedTitle,
		latestRevisionId: edit.newrevid,
		latestRevisionTimestamp: edit.newtimestamp,
		contentModel: edit.contentmodel,
		...(bot === true ? { botMarked: await ctx.edit.botRight(mwn) } : {}),
		url: await buildPageUrl(ctx, resolvedTitle),
	});
}
