import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';
import { neowikiRequest, neowikiErrorResult } from './neowikiRequest.js';

const statementSchema = z.object({
	propertyType: z
		.string()
		.min(1)
		.describe('Property type: text, url, date, datetime, select, number, boolean, or relation.'),
	value: z
		.unknown()
		.describe(
			'text/url/date/datetime → array of strings; select → array of option IDs; number → number; boolean → boolean; relation → array of { target: subjectId, properties? }.',
		),
});

const inputSchema = {
	id: z
		.string()
		.min(1)
		.describe('Subject ID to replace (starts with s…). Resolve one with neowiki-search-subjects.'),
	label: z.string().min(1).describe('New display label. Required, non-empty.'),
	statements: z
		.record(z.string(), statementSchema)
		.describe(
			'Full replacement statement map (property name → { propertyType, value }). Property names absent from this map are deleted; pass {} to clear all statements. The key is propertyType, NOT the `type` read tools return.',
		),
	comment: z.string().optional().describe('Optional edit summary.'),
} as const;

interface UpdateResponse {
	status?: string;
	subjectId?: string;
}

export const neowikiUpdateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-update-subject',
	description:
		'Replaces a NeoWiki Subject\'s label and statements — a FULL replace: property names absent from `statements` are deleted, and {} clears all statements. Enabled only when the wiki has NeoWiki installed. The Subject\'s id and schema are immutable. Requires the edit right. Read the current state with neowiki-get-subject first. Each statement is keyed by property name as { propertyType, value } — the key is propertyType, NOT the `type` key read tools return. Value by type: text/url/date/datetime → array of strings; select → array of option IDs (resolve via neowiki-get-schema); number → a number; boolean → a boolean; relation → array of { target: "<subjectId>", properties? }. Pre-validate with neowiki-validate-subject. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Update NeoWiki subject',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'update NeoWiki subject',
	target: (a) => a.id,

	async handle({ id, label, statements, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki replace response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'PUT',
				path: `/subject/${encodeURIComponent(id)}`,
				csrf: true,
				body: { label, statements, ...(comment !== undefined ? { comment } : {}) },
			})) as UpdateResponse;

			return ctx.format.ok({ subjectId: data.subjectId ?? id, status: data.status ?? 'updated' });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
