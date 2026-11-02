import { z } from 'zod';

/**
 * The `bot` input shared by the Wikibase write tools.
 *
 * It maps to the `bot` parameter that `wbeditentity` and `wbcreateclaim` both
 * accept. It is optional and has no schema default on purpose: an absent value
 * means "use the wiki's `bot` setting" (see `resolveBotFlag`), which a `.default(false)`
 * would defeat by always overriding the operator's choice.
 */
export const botInput = z
	.boolean()
	.optional()
	.describe(
		"Marks the edit as a bot edit, which Special:RecentChanges hides by default. When omitted, the wiki's own setting decides, and that is off unless the operator turned it on; pass false to leave a single edit unflagged. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.",
	);
