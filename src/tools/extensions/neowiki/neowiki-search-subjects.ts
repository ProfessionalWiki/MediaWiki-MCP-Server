import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.ts';

// The /subject-labels endpoint caps `limit` at 50 and has no continuation.
const RESULT_LIMIT = 50;

const inputSchema = {
	schema: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Limits matches to Subjects of this Schema, named exactly, with matching case. Omit to search every Schema. Use neowiki-list-schemas to discover names.',
		),
	search: z.string().min(1).describe('Name prefix to match, case-insensitively.'),
} as const;

interface SubjectLabel {
	id?: string;
	label?: string;
	pageTitle?: string;
}

export const neowikiSearchSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-search-subjects',
	description:
		"Finds NeoWiki Subjects whose name starts with the given text, returning each match's opaque Subject ID (s…), its name as `label`, and the page title of the wiki page holding it. Enabled only when the wiki has NeoWiki installed. A Subject's name is its label, or for a Main Subject without one, its page title; Dependent Subjects and other Subjects without a label are not found. Subject IDs are not human-readable, so use this to resolve a name to an ID for neowiki-get-subject or a parameterized neowiki-cypher-query. Returns at most 50 matches. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Search NeoWiki subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'search NeoWiki subjects',
	target: (a) => a.search,

	async handle({ schema, search }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject-labels response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: '/subject-labels',
				query: {
					search,
					limit: String(RESULT_LIMIT),
					...(schema !== undefined ? { schema } : {}),
				},
			})) as SubjectLabel[];

			const subjects = Array.isArray(data) ? data : [];
			const truncation: TruncationInfo | null =
				subjects.length >= RESULT_LIMIT
					? {
							reason: 'capped-no-continuation',
							returnedCount: subjects.length,
							limit: RESULT_LIMIT,
							itemNoun: 'subjects',
							narrowHint: 'lengthen the search prefix or pass a schema',
						}
					: null;

			return ctx.format.ok({ subjects, ...(truncation !== null ? { truncation } : {}) });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
