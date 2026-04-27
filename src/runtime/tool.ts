/* eslint-disable n/no-missing-import */
import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { ToolContext } from './context.js';

export interface Tool<TSchema extends ZodRawShape> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: TSchema;
	readonly annotations: ToolAnnotations;
	readonly handle: (
		args: z.infer<z.ZodObject<TSchema>>,
		ctx: ToolContext
	) => Promise<CallToolResult>;
}
