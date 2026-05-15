import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
			// `buildToolInputSchema` returns a `ZodRawShape` (the descriptor's own
			// shape, optionally with the shared `wiki` field merged in). The cast
			// re-narrows it to `TSchema` for the SDK's generic boundary; the merged
			// `wiki` field is an optional extra the handler simply ignores.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; the merged schema is a superset of TSchema
			inputSchema: buildToolInputSchema(tool) as TSchema,
			annotations: tool.annotations,
		},
		// The SDK callback signature is `(args, extra) => ...`. Our descriptor
		// handlers ignore the `extra` parameter, so we widen the type here. The
		// `ZodRawShape` constraint from zod is the same shape as the SDK's
		// `ZodRawShapeCompat` (Record<string, AnySchema>) — TypeScript just
		// can't unify them through the generic boundary.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic boundary; MCP SDK's ToolCallback can't be unified with our typed handler
		handler as unknown as ToolCallback<TSchema>,
	);
}
