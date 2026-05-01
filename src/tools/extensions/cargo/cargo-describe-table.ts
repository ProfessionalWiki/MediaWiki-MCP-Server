import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../../../runtime/tool.js';
import type { ToolContext } from '../../../runtime/context.js';

const inputSchema = {
	table: z.string().min(1).describe('Cargo table name. Use cargo-list-tables to discover.'),
} as const;

interface CargoFieldRaw {
	type?: string;
	isList?: unknown;
	delimiter?: string;
}

interface CargoFieldsResponse {
	cargofields?: Record<string, CargoFieldRaw>;
}

interface FieldDescriptor {
	name: string;
	type: string;
	isList?: true;
	delimiter?: string;
}

export const cargoDescribeTable: Tool<typeof inputSchema> = {
	name: 'cargo-describe-table',
	description:
		"Returns the field schema for a Cargo table on the active wiki: each field's name, type (String/Integer/Boolean/Date/Page/Coordinates/etc.), and — for list-typed fields — its delimiter. Enabled only when the wiki has Cargo installed. Use before constructing a cargo-query so the where clause uses the right operators (HOLDS / HOLDS LIKE for list fields, MATCHES for Searchtext, NEAR for Coordinates). Use cargo-list-tables to discover table names.",
	inputSchema,
	annotations: {
		title: 'Describe Cargo table',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'describe Cargo table',
	target: (a) => a.table,

	async handle({ table }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const raw = await mwn.request({
			action: 'cargofields',
			table,
			format: 'json',
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cargo action=cargofields response shape; trusted at this boundary
		const response = raw as CargoFieldsResponse;

		const fieldMap = response.cargofields ?? {};
		const fields: FieldDescriptor[] = Object.entries(fieldMap).map(([name, entry]) =>
			normalizeField(name, entry),
		);

		return ctx.format.ok({ fields });
	},
};

function normalizeField(name: string, raw: CargoFieldRaw): FieldDescriptor {
	const out: FieldDescriptor = {
		name,
		type: typeof raw.type === 'string' ? raw.type : '',
	};
	// Cargo emits isList as an empty-string presence flag rather than a
	// boolean. Treat any presence (including empty string) as truthy.
	if (raw.isList !== undefined) {
		out.isList = true;
		if (typeof raw.delimiter === 'string') {
			out.delimiter = raw.delimiter;
		}
	}
	return out;
}
