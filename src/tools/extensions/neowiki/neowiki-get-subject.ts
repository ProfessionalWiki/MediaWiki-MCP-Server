import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe(
			'Subject ID (starts with s…). Use neowiki-search-subjects to resolve one from a label.',
		),
} as const;

interface SubjectStatement {
	type?: string;
	value?: unknown;
}

interface SubjectData {
	id?: string;
	label?: string;
	schema?: string;
	statements?: Record<string, SubjectStatement>;
}

interface GetSubjectResponse {
	requestedId?: string;
	subjects?: Record<string, SubjectData>;
}

export const neowikiGetSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-get-subject',
	description:
		'Fetches one NeoWiki Subject by ID — its label, schema, and statements with typed values. Enabled only when the wiki has NeoWiki installed. Richer than a flattened Cypher node: it preserves multi-part values and per-statement types. `select` values are option IDs — decode them with neowiki-get-schema. Get an ID from neowiki-search-subjects or a Cypher query. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Get NeoWiki subject',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'get NeoWiki subject',
	target: (a) => a.id,

	async handle({ id }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'GET',
				path: `/subject/${encodeURIComponent(id)}`,
			})) as GetSubjectResponse;

			const subject = data.subjects?.[id];
			if (subject === undefined) {
				return ctx.format.notFound(`NeoWiki subject "${id}" not found`);
			}

			return ctx.format.ok(flattenSubject(subject, id));
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};

export function flattenSubject(
	subject: SubjectData,
	fallbackId: string,
): {
	id: string;
	label: string;
	schema: string;
	statements: Array<{ property: string; type: string; value: unknown }>;
} {
	const statements = Object.entries(subject.statements ?? {}).map(([property, statement]) => ({
		property,
		type: typeof statement.type === 'string' ? statement.type : '',
		value: statement.value,
	}));
	return {
		id: subject.id ?? fallbackId,
		label: subject.label ?? '',
		schema: subject.schema ?? '',
		statements,
	};
}
