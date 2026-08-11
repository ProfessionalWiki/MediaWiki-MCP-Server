import type { ToolContext } from '../../../runtime/context.ts';
import { formatEditComment } from '../../../wikis/utils.ts';

/**
 * The edit summary a NeoWiki write should carry, attributed to the tool making
 * it, or `undefined` when there is none to send: a wiki that has turned
 * attribution off and a caller that gave no comment. NeoWiki reads an absent
 * comment as "use my own default summary" and an empty one as the summary
 * itself, so the two cases must stay distinct.
 */
export function attributedComment(
	ctx: ToolContext,
	tool: string,
	comment?: string,
): string | undefined {
	const attributed = formatEditComment(ctx, tool, comment);
	return attributed === '' ? undefined : attributed;
}
