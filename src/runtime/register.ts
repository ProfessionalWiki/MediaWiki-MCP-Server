import type {
	McpServer,
	RegisteredTool,
	ServerContext,
	ToolCallback,
	CallToolResult,
} from '@modelcontextprotocol/server';
import type { ZodRawShape, z } from 'zod';
import type { Tool } from './tool.ts';
import type { ToolContext } from './context.ts';
import { buildToolInputSchema } from './wikiArg.ts';
import { withRequestFields } from './requestContext.ts';

/**
 * Runs `fn` with the SDK request's cancellation signal in the request scope, so
 * `ctx.mwn()` can apply it to that request's MediaWiki calls. The signal lives
 * at `ctx.mcpReq.signal`, not on the context root. The key is written only when
 * a signal is actually present, so a scope set further out is never clobbered
 * with `undefined`.
 */
function withRequestScope<T>(ctx: ServerContext | undefined, fn: () => Promise<T>): Promise<T> {
	const signal = ctx?.mcpReq?.signal;
	return signal === undefined ? fn() : withRequestFields({ signal }, fn);
}

export function register<TSchema extends ZodRawShape, TCtx extends ToolContext>(
	server: McpServer,
	tool: Tool<TSchema, TCtx>,
	handler: (args: z.infer<z.ZodObject<TSchema>>) => Promise<CallToolResult>,
): RegisteredTool {
	return server.registerTool(
		tool.name,
		{
			description: tool.description,
			// `buildToolInputSchema` wraps the descriptor's own shape (optionally
			// with the shared `wiki` field merged in) in a `z.object()`. The cast
			// re-narrows it to `TSchema` for the SDK's generic boundary; the merged
			// `wiki` field is an optional extra the handler simply ignores.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; the merged schema is a superset of TSchema
			inputSchema: buildToolInputSchema(tool) as z.ZodObject<TSchema>,
			annotations: tool.annotations,
		},
		// The SDK callback signature is `(args, ctx) => ...`. Descriptor handlers
		// take only `args`, so the `ctx` the SDK supplies is consumed here: its
		// cancellation signal goes into the request scope, where `ctx.mwn()`
		// picks it up and applies it to that request's MediaWiki calls. The
		// parameter is typed as the SDK's own `ServerContext` rather than a
		// hand-written shape so the compiler checks the property path — the cast
		// below erases it, and an invented shape silently reads `undefined`.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; MCP SDK's ToolCallback can't be unified with our typed handler
		((args: z.infer<z.ZodObject<TSchema>>, ctx: ServerContext) =>
			withRequestScope(ctx, () => handler(args))) as unknown as ToolCallback<z.ZodObject<TSchema>>,
	);
}
