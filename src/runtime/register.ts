import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
	CallToolResult,
} from '@modelcontextprotocol/server';
import type { ZodRawShape, z } from 'zod';
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { buildToolInputSchema } from './wikiArg.js';

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
		// The SDK callback signature is `(args, ctx) => ...`. Our descriptor
		// handlers ignore the `ctx` parameter, so we widen the type here:
		// TypeScript can't unify our concrete handler with the SDK's generic
		// `ToolCallback` through the generic boundary.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; MCP SDK's ToolCallback can't be unified with our typed handler
		handler as unknown as ToolCallback<z.ZodObject<TSchema>>,
	);
}
