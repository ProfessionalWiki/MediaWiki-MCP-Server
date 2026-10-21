import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { flattenSubject, type SubjectData } from './subjects.ts';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe(
			'Subject ID (starts with s…). Use neowiki-search-subjects to resolve one from a label.',
		),
} as const;

interface GetSubjectResponse {
	requestedId?: string;
	subjects?: Record<string, SubjectData>;
}

export const neowikiGetSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-get-subject',
	description:
		'Fetches one NeoWiki Subject by ID — its label, display name, schema, the wiki page holding it, and statements with typed values. Enabled only when the wiki has NeoWiki installed. Richer than a flattened Cypher node: it preserves multi-part values and per-statement types. `select` values are option IDs — decode them with neowiki-get-schema. A Dependent Subject has no label and carries hostSubject, the Subject it belongs to, and is named after its Schema and that Host Subject ("Birth of Pablo Picasso"). Get an ID from neowiki-search-subjects or a Cypher query. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Get NeoWiki subject',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'get NeoWiki subject',
	target: (a) => a.id,

	async handle({ id }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'GET',
			path: `/subject/${encodeURIComponent(id)}`,
			query: { expand: 'page' },
		})) as GetSubjectResponse;

		const subject = data.subjects?.[id];
		if (subject === undefined) {
			return ctx.format.notFound(`NeoWiki subject "${id}" not found`);
		}

		return ctx.format.ok(flattenSubject(subject, id));
	},
};
