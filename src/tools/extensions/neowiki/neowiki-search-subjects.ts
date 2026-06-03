import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const inputSchema = {
	schema: z
		.string()
		.min(1)
		.describe('Schema to search within. Use neowiki-list-schemas to discover names.'),
	search: z.string().min(1).describe('Label text to match (e.g. a name or prefix).'),
} as const;

interface SubjectLabel {
	id?: string;
	label?: string;
}

export const neowikiSearchSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-search-subjects',
	description:
		"Finds NeoWiki Subjects by label within a Schema, returning each match's opaque Subject ID (s…) and label. Enabled only when the wiki has NeoWiki installed. Subject IDs are not human-readable, so use this to resolve a name to an ID for neowiki-get-subject or a parameterized neowiki-cypher-query. Pre-1.0: the NeoWiki API may change without notice.",
	inputSchema,
	annotations: {
		title: 'Search NeoWiki subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'search NeoWiki subjects',
	target: (a) => a.search,

	async handle({ schema, search }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject-labels response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: '/subject-labels',
				query: { schema, search },
			})) as SubjectLabel[];

			const subjects = Array.isArray(data) ? data : [];
			return ctx.format.ok({ subjects });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
