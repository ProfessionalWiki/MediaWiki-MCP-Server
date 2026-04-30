import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';

const inputSchema = {} as const;

interface CargoTablesResponse {
	cargotables?: unknown[];
}

export const cargoListTables: Tool<typeof inputSchema> = {
	name: 'cargo-list-tables',
	description:
		"Lists all Cargo tables defined on the active wiki, including Cargo's built-in system tables (underscore-prefixed: `_pageData`, `_fileData`, etc.). Use cargo-describe-table to inspect a table's fields and types before constructing a cargo-query.",
	inputSchema,
	annotations: {
		title: 'List Cargo tables',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'list Cargo tables',

	async handle(_args, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const raw = await mwn.request({
			action: 'cargotables',
			format: 'json',
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cargo action=cargotables response shape; trusted at this boundary
		const response = raw as CargoTablesResponse;

		const tables = Array.isArray(response.cargotables)
			? response.cargotables.filter((t): t is string => typeof t === 'string')
			: [];

		return ctx.format.ok({ tables });
	},
};
