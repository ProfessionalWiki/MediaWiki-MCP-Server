import { z } from 'zod';

/** The `bot` input of the Wikibase write tools, which `wbeditentity` and `wbcreateclaim` both accept. */
export const botInput = z
	.boolean()
	.optional()
	.describe(
		'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the account has the `bot` right, and a bot password or OAuth consumer also needs the High-volume (bot) access grant; otherwise the edit saves unflagged and the response reports botMarked: false. Use for bulk or automated edit runs, or when the user requests it.',
	);
