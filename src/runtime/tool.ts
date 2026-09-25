import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';

export interface Tool<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: TSchema;
	/**
	 * readOnlyHint is required, not optional as in the SDK, because it decides
	 * whether the read-only gate treats the tool as a write (isWriteTool in
	 * wikiCapability.ts).
	 */
	readonly annotations: ToolAnnotations & { readonly readOnlyHint: boolean };
	/**
	 * Verb phrase used by the dispatcher to wrap raw upstream errors as
	 * "Failed to <verb>: <message>". Falls back to `name` if omitted.
	 */
	readonly failureVerb?: string;
	/**
	 * Extracts a single identifier from the tool's input args (typically a page
	 * title, search query, or URL) for the `target` field of the `tool_call`
	 * telemetry event. Omitted for tools that don't have a single canonical
	 * subject (e.g. get-pages, compare-pages).
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
