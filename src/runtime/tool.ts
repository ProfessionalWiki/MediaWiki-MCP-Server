/* eslint-disable n/no-missing-import */
import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { ToolContext } from './context.js';

export interface Tool<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: TSchema;
	readonly annotations: ToolAnnotations;
	/**
	 * Verb phrase used by the dispatcher to wrap raw upstream errors as
	 * "Failed to <verb>: <message>". Falls back to `name` if omitted.
	 */
	readonly failureVerb?: string;
	/**
	 * Extracts a single identifier from the tool's input args (typically a page
	 * title, search query, or URL) for the `target` field of the `tool_call`
	 * telemetry event. Omitted for tools that don't have a single canonical
	 * subject (e.g. get-pages, compare-pages, set-wiki).
	 */
	readonly target?: (args: z.infer<z.ZodObject<TSchema>>) => string;
	readonly handle: (args: z.infer<z.ZodObject<TSchema>>, ctx: TCtx) => Promise<CallToolResult>;
}
