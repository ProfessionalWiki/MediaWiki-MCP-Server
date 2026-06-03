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
		.describe('Value in the format for the propertyType (see neowiki-create-subject).'),
});

const inputSchema = {
	id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Subject ID to validate an UPDATE against (its schema is used). Omit to validate a NEW subject and pass schema instead.',
		),
	schema: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Schema name to validate a NEW subject against. Required when id is omitted; ignored when id is given.',
		),
	label: z
		.string()
		.describe(
			'Proposed display label. May be empty — an empty label yields a label-required violation rather than an error.',
		),
	statements: z
		.record(z.string(), statementSchema)
		.describe(
			'Proposed statement map (property name → { propertyType, value }). The key is propertyType, NOT the `type` read tools return.',
		),
} as const;

interface ValidateResponse {
	violations?: unknown[];
}

export const neowikiValidateSubject: Tool<typeof inputSchema> = {
	name: 'neowiki-validate-subject',
	description:
		'Dry-runs validation of a proposed NeoWiki Subject against its Schema and returns any violations WITHOUT writing. Enabled only when the wiki has NeoWiki installed. Provide id to validate an update to an existing Subject (its schema is used), or omit id and provide schema to validate a new Subject. Use before neowiki-create-subject / neowiki-update-subject to catch type mismatches, missing required properties, and the propertyType-vs-type footgun. Returns { violations: [] } when valid. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Validate NeoWiki subject',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'validate NeoWiki subject',
	target: (a) => a.id ?? a.schema ?? '',

	async handle({ id, schema, label, statements }, ctx: ToolContext): Promise<CallToolResult> {
		if (id === undefined && schema === undefined) {
			return ctx.format.invalidInput(
				'Provide schema to validate a new subject, or id to validate an update.',
			);
		}

		const mwn = await ctx.mwn();
		try {
			const spec =
				id !== undefined
					? { path: `/subject/${encodeURIComponent(id)}/validate`, body: { label, statements } }
					: { path: '/subject/validate', body: { schema, label, statements } };

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki validate response shape; trusted at this boundary
			const data = (await neowikiRequest(mwn, {
				method: 'POST',
				path: spec.path,
				body: spec.body,
			})) as ValidateResponse;

			return ctx.format.ok({ violations: Array.isArray(data.violations) ? data.violations : [] });
		} catch (err) {
			return neowikiErrorResult(err, ctx);
		}
	},
};
