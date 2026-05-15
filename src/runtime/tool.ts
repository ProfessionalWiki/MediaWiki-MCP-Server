import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
	/**
	 * Whether this tool operates on a wiki and therefore accepts the per-call
	 * `wiki` argument. Defaults to `true` when omitted. Registry-management and
	 * OAuth-store tools set this to `false`.
	 */
	readonly wikiScoped?: boolean;
	readonly handle: (args: z.infer<z.ZodObject<TSchema>>, ctx: TCtx) => Promise<CallToolResult>;
}
