import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { neowikiRequest } from './neowikiRequest.ts';

// The /subjects endpoint caps `limit` at 50.
const PAGE_LIMIT = 50;

const inputSchema = {
	schema: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Lists only the Subjects of this Schema, named exactly, with matching case. Omit to list every Schema except Dependent Subjects. Use neowiki-list-schemas to discover names.',
		),
	search: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Keeps the Subjects whose name or page title contains this text, in any case, or whose ID starts with it.',
		),
	sort: z
		.enum(['newest', 'name', 'schema', 'page', 'edited'])
		.optional()
		.describe(
			'Order of the list: newest (by creation, newest first; the default), name, schema, page (by page title) or edited (by lastEdited).',
		),
	direction: z
		.enum(['asc', 'desc'])
		.optional()
		.describe('Direction of the sort: asc (the default) or desc. newest ignores it.'),
	continueFrom: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque cursor from a previous response; omit on first call.'),
} as const;

interface SubjectRow {
	displayNameIsGenerated?: boolean;
	hostSubject?: SubjectRow;
	[field: string]: unknown;
}

interface ListSubjectsResponse {
	subjects?: SubjectRow[];
	nextCursor?: string | null;
}

function withoutDefaults({
	displayNameIsGenerated,
	hostSubject,
	...row
}: SubjectRow): Record<string, unknown> {
	return {
		...row,
		...(displayNameIsGenerated === true ? { displayNameIsGenerated } : {}),
		...(hostSubject !== undefined ? { hostSubject: withoutDefaults(hostSubject) } : {}),
	};
}

export const neowikiListSubjects: Tool<typeof inputSchema> = {
	name: 'neowiki-list-subjects',
	description:
		'Lists NeoWiki Subjects 50 at a time, each with its ID, displayName, Schema, the page holding it as pageId and pageTitle, and lastEdited, when that page was last edited (ISO 8601, UTC). Enabled only when the wiki has NeoWiki installed. A Subject without a chosen name is listed under its Schema name, with displayNameIsGenerated: true, absent otherwise; a Dependent Subject also carries hostSubject, the Subject it belongs to. Paginate with continueFrom. A listing can end early where the caller may not read many of the pages. To resolve a name to an ID in one call, use neowiki-search-subjects; to query by statement values, use neowiki-cypher-query.',
	inputSchema,
	annotations: {
		title: 'List NeoWiki subjects',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'list NeoWiki subjects',

	async handle(
		{ schema, search, sort, direction, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subjects response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'GET',
			path: '/subjects',
			query: {
				limit: String(PAGE_LIMIT),
				...(schema !== undefined ? { schema } : {}),
				...(search !== undefined ? { search } : {}),
				...(sort !== undefined ? { sort } : {}),
				...(direction !== undefined ? { direction } : {}),
				...(continueFrom !== undefined ? { cursor: continueFrom } : {}),
			},
		})) as ListSubjectsResponse;

		const subjects = (Array.isArray(data.subjects) ? data.subjects : []).map(withoutDefaults);
		const truncation: TruncationInfo | null =
			typeof data.nextCursor === 'string'
				? {
						reason: 'more-available',
						returnedCount: subjects.length,
						itemNoun: 'subjects',
						toolName: 'neowiki-list-subjects',
						continueWith: { param: 'continueFrom', value: data.nextCursor },
					}
				: null;

		return ctx.format.ok({ subjects, ...(truncation !== null ? { truncation } : {}) });
	},
};
