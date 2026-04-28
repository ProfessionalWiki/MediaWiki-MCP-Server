/* eslint-disable n/no-missing-import */
import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { ZodRawShape, z } from 'zod';
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';

export function register<TSchema extends ZodRawShape, TCtx extends ToolContext>(
	server: McpServer,
	tool: Tool<TSchema, TCtx>,
	handler: (args: z.infer<z.ZodObject<TSchema>>) => Promise<CallToolResult>,
): RegisteredTool {
	return server.registerTool(
		tool.name,
		{
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		},
		// The SDK callback signature is `(args, extra) => ...`. Our descriptor
		// handlers ignore the `extra` parameter, so we widen the type here. The
		// `ZodRawShape` constraint from zod is the same shape as the SDK's
		// `ZodRawShapeCompat` (Record<string, AnySchema>) — TypeScript just
		// can't unify them through the generic boundary.
		handler as unknown as ToolCallback<TSchema>,
	);
}
