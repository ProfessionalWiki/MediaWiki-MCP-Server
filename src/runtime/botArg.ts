import { z } from 'zod';

export const botArgSchema = z
	.boolean()
	.optional()
	.describe(
		'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Applies only if the account has the `bot` right and, through a bot password or OAuth consumer, the High-volume (bot) access grant; otherwise the edit saves unflagged and the response reports botMarked: false. Use for bulk or automated edits, or when the user asks.',
	);
