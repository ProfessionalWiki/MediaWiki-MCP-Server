import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.ts';
import type { ToolContext } from '../../src/runtime/context.ts';

// Calls a tool the way a client does: over a real MCP session, so the arguments
// pass through the registered zod schema on their way to the handler.
//
// Tests that call `tool.handle(...)` or `dispatch(...)` supply already-parsed
// arguments, because the SDK owns validation and neither of those goes through
// it. They therefore cannot see a schema that rejects a well-formed call, and a
// literal in the test satisfies a schema the wire never would. Use this helper
// whenever the assertion is about what the schema accepts or refuses.
export async function callTool(
	ctx: ToolContext,
	name: string,
	args: Record<string, unknown>,
): Promise<CallToolResult> {
	const server = await createServer(ctx);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'call-tool-helper', version: '0.0.0' });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	try {
		return (await client.callTool({ name, arguments: args })) as CallToolResult;
	} finally {
		await client.close();
		await server.close();
	}
}

// Asserts the schema refused the call, and returns the message so a test can
// name the argument at fault. A handler that failed for its own reasons sets
// `isError` too, so the marker text is what tells the two apart. Schema
// rejections carry no ErrorEnvelope, which is why assertStructuredError from
// structuredResult.ts does not fit here.
export function assertRefusedArgument(result: CallToolResult): string {
	expect(result.isError).toBe(true);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validation errors always carry a single text block
	const text = (result.content![0] as TextContent).text;
	expect(text).toContain('Input validation error');
	return text;
}
