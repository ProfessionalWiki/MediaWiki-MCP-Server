import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { presentSubject, type SubjectData } from './subjects.ts';

// The /referencingSubjects endpoint caps `limit` at 50 and has no continuation.
const RESULT_LIMIT = 50;

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe(
			'ID of the Subject the relations point at (starts with s…). Resolve one with neowiki-search-subjects.',
		),
} as const;

interface ReferencingSubjectsResponse {
	referencingSubjects?: Array<{ subject?: SubjectData; propertyNames?: string[] }>;
	truncated?: boolean;
}

export const neowikiGetReferencingSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-get-referencing-subjects',
	description:
		'Lists the NeoWiki Subjects whose relations point at a given Subject, each as neowiki-get-subject returns a Subject, as the wiki publishes it, with propertyNames: the relation properties that point. Enabled only when the wiki has NeoWiki installed, with or without a graph store. Ordered by name, Subjects without a chosen name last; at most 50, leaving out Subjects on pages the caller may not read. A Subject that does not exist, or that the caller may not read, has none. Use it before neowiki-delete-subject, which leaves these relations pointing at a Subject that no longer exists.',
	inputSchema,
	annotations: {
		title: 'Get NeoWiki referencing subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'get NeoWiki referencing subjects',
	target: (a) => a.id,

	async handle({ id }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /referencingSubjects response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'GET',
			path: `/subject/${encodeURIComponent(id)}/referencingSubjects`,
			query: { limit: String(RESULT_LIMIT) },
		})) as ReferencingSubjectsResponse;

		const referencingSubjects = (
			Array.isArray(data.referencingSubjects) ? data.referencingSubjects : []
		).map(({ subject, propertyNames }) => ({
			subject: presentSubject(subject ?? {}, ''),
			propertyNames: Array.isArray(propertyNames) ? propertyNames : [],
		}));
		const truncation: TruncationInfo | null =
			data.truncated === true
				? {
						reason: 'capped-no-continuation',
						returnedCount: referencingSubjects.length,
						limit: RESULT_LIMIT,
						itemNoun: 'referencing subjects',
						narrowHint:
							'on a wiki with Neo4j, neowiki-cypher-query lists every Subject with a relation to it',
					}
				: null;

		return ctx.format.ok({
			referencingSubjects,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
