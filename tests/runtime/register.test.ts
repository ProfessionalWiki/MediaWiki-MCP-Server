import { describe, it, expect, vi, type Mock } from 'vitest';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { register } from '../../src/runtime/register.ts';
import type { Tool } from '../../src/runtime/tool.ts';

// `register` wraps the descriptor's raw shape in a z.object() before handing it
// to the SDK, so the registered field names are read back off `.shape`.
function registeredShape(registerTool: Mock): ZodRawShape {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reading back the schema this call registered
	const config = registerTool.mock.calls[0][1] as { inputSchema: z.ZodObject<ZodRawShape> };
	return config.inputSchema.shape;
}

describe('register', () => {
	it('forwards descriptor metadata and handler to server.registerTool', () => {
		const registerTool = vi.fn().mockReturnValue({ x: 1 });
		const server = { registerTool } as never;
		const tool: Tool<{ a: z.ZodString }> = {
			name: 'foo',
			description: 'd',
			inputSchema: { a: z.string() },
			annotations: {
				title: 'F',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			handle: async () => ({ content: [] }),
		};
		const handler = vi.fn();
		register(server, tool, handler);
		expect(registerTool).toHaveBeenCalledWith(
			'foo',
			expect.objectContaining({
				description: 'd',
				annotations: tool.annotations,
			}),
			// Not `handler` itself: register wraps it so the SDK's per-request
			// context can be consumed before the descriptor handler runs.
			expect.any(Function),
		);
		// objectContaining above ignores extra keys, so pin the exact set too.
		expect(Object.keys(registerTool.mock.calls[0][1]).sort()).toEqual([
			'annotations',
			'description',
			'inputSchema',
		]);
		// Wiki-scoped tools (the default) get the shared `wiki` field merged in.
		expect(Object.keys(registeredShape(registerTool))).toEqual(['a', 'wiki']);
	});

	it('omits the wiki field for non-wiki-scoped tools', () => {
		const registerTool = vi.fn().mockReturnValue({ x: 1 });
		const server = { registerTool } as never;
		const tool: Tool<{ a: z.ZodString }> = {
			name: 'foo',
			description: 'd',
			wikiScoped: false,
			inputSchema: { a: z.string() },
			annotations: {
				title: 'F',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			handle: async () => ({ content: [] }),
		};
		register(server, tool, vi.fn());
		expect(Object.keys(registeredShape(registerTool))).toEqual(['a']);
	});

	it('returns the result of server.registerTool', () => {
		const registered = { enabled: true } as never;
		const registerTool = vi.fn().mockReturnValue(registered);
		const server = { registerTool } as never;
		const tool: Tool<{ a: z.ZodString }> = {
			name: 'bar',
			description: 'd',
			inputSchema: { a: z.string() },
			annotations: {
				title: 'B',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			handle: async () => ({ content: [] }),
		};
		const result = register(server, tool, vi.fn());
		expect(result).toBe(registered);
	});

	// The signal reaching the handler is covered in tests/runtime/cancellation.test.ts,
	// against a real McpServer. Asserting it here would mean fabricating the SDK's
	// context object, which proves only that the implementation reads the shape the
	// test invented for it.
	it('still runs the handler when the SDK supplies no signal', async () => {
		const registerTool = vi.fn().mockReturnValue({});
		const server = { registerTool } as never;
		const tool: Tool<{ a: z.ZodString }> = {
			name: 'qux',
			description: 'd',
			inputSchema: { a: z.string() },
			annotations: {
				title: 'Q',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			handle: async () => ({ content: [] }),
		};
		let ran = false;
		register(server, tool, async () => {
			ran = true;
			return { content: [] };
		});

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- invoking the callback this call registered
		const registered = registerTool.mock.calls[0][2] as (
			args: unknown,
			extra?: { signal?: AbortSignal },
		) => Promise<unknown>;
		await registered({ a: 'x' });

		expect(ran).toBe(true);
	});
});
