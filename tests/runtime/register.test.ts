import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { register } from '../../src/runtime/register.js';
import type { Tool } from '../../src/runtime/tool.js';

describe( 'register', () => {
	it( 'forwards descriptor metadata and handler to server.registerTool', () => {
		const registerTool = vi.fn().mockReturnValue( { x: 1 } );
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
				openWorldHint: true
			},
			handle: async () => ( { content: [] } )
		};
		const handler = vi.fn();
		register( server, tool, handler );
		expect( registerTool ).toHaveBeenCalledWith(
			'foo',
			{
				description: 'd',
				inputSchema: { a: expect.anything() },
				annotations: tool.annotations
			},
			handler
		);
	} );

	it( 'returns the result of server.registerTool', () => {
		const registered = { enabled: true } as never;
		const registerTool = vi.fn().mockReturnValue( registered );
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
				openWorldHint: true
			},
			handle: async () => ( { content: [] } )
		};
		const result = register( server, tool, vi.fn() );
		expect( result ).toBe( registered );
	} );
} );
