import { z } from 'zod';

// No schema default: an omitted `bot` defers to the wiki's `bot` setting, which
// a default of false would override.
export const botArgSchema = z
	.boolean()
	.optional()
	.describe(
		'Marks the edit as a bot edit, which Special:RecentChanges hides by default. When omitted, the bot setting of the wiki decides; pass false to leave one edit unflagged. Applies only if the account has the `bot` right and, through a bot password or OAuth consumer, the High-volume (bot) access grant; otherwise the edit saves unflagged and the response reports botMarked: false. Use for bulk or automated edits, or when the user asks.',
	);
