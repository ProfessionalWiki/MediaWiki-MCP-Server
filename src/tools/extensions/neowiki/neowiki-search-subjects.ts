import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { neowikiRequest } from './neowikiRequest.ts';

// The /subject-labels endpoint caps `limit` at 50 and has no continuation.
const RESULT_LIMIT = 50;

const inputSchema = {
	schema: z
		.array(z.string().min(1))
		.nonempty()
		.optional()
		.describe(
			'Limits results to Subjects of these Schemas, each named exactly, with matching case. Omit to search every Schema. Use neowiki-list-schemas to discover names.',
		),
	search: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Name prefix to match, case-insensitively. Omit to list the Subjects of the given schemas instead.',
		),
} as const;

interface SubjectLabel {
	id?: string;
	label?: string;
	pageTitle?: string;
}

export const neowikiSearchSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-search-subjects',
	description:
		"Finds NeoWiki Subjects by name, returning each one's opaque Subject ID (s…), its name as `label`, and the page title of the wiki page holding it. Enabled only when the wiki has NeoWiki installed. With a search, it finds the Subjects whose name starts with it; without one, it lists the Subjects of the given schemas in name order. A Subject's name is its label, or for a Main Subject without one, the title of its page, unless the page is titled by the ID of a Subject on it. Dependent Subjects are never returned, and other Subjects without a name are not found by a search. Subject IDs are not human-readable, so use this to resolve a name to an ID for neowiki-get-subject or a parameterized neowiki-cypher-query. Returns at most 50 Subjects. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Search NeoWiki subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'search NeoWiki subjects',
	target: (a) => a.search ?? a.schema?.join('|') ?? '',

	async handle({ schema, search }, ctx: ToolContext): Promise<CallToolResult> {
		if (search === undefined && schema === undefined) {
			return ctx.format.invalidInput('Pass a search, or the schemas whose Subjects to list.');
		}

		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject-labels response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'GET',
			path: '/subject-labels',
			query: {
				...(search !== undefined ? { search } : {}),
				limit: String(RESULT_LIMIT),
				...(schema !== undefined ? { schema: schema.join('|') } : {}),
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
						narrowHint: 'search by a longer name prefix, or in fewer schemas',
					}
				: null;

		return ctx.format.ok({ subjects, ...(truncation !== null ? { truncation } : {}) });
	},
};
