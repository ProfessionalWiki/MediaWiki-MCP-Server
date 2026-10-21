import type { ZodRawShape, z } from 'zod';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/server';
import type { SharedContext, ToolContext } from './context.ts';
import type { ReconcileContext } from './reconcile.ts';
import type { TailoredErrors } from '../errors/tailoredErrors.ts';

export interface Tool<TSchema extends ZodRawShape, TCtx extends SharedContext = ToolContext> {
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
	 * Wordings for some of the wiki's errors, by error code, that replace the
	 * "Failed to <verb>: <message>" the dispatcher otherwise reports.
	 */
	readonly tailoredErrors?: TailoredErrors;
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
	 * OAuth-store tools set this to `false`, which their `SharedContext`, holding
	 * no wiki, requires.
	 */
	readonly wikiScoped?: TCtx extends ToolContext ? true : false;
	/**
	 * When the tool is offered in tools/list, on top of the gates every tool
	 * shares (read-only wikis, extension packs). Omitted for a tool always offered.
	 */
	readonly offeredWhen?: (context: ReconcileContext) => boolean;
	readonly handle: (args: z.infer<z.ZodObject<TSchema>>, ctx: TCtx) => Promise<CallToolResult>;
}
