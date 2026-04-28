import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { dispatch } from '../../src/runtime/dispatcher.js';
import type { Tool } from '../../src/runtime/tool.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';

const noopTool = (
	handle: Tool<{ x: z.ZodString }>[ 'handle' ]
): Tool<{ x: z.ZodString }> => ( {
	name: 'get-page',
	description: 'd',
	inputSchema: { x: z.string() },
	annotations: {
		title: 't',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	handle
} );

describe( 'dispatcher', () => {
	it( 'returns successful results unchanged', async () => {
		const ctx = fakeContext();
		const tool = noopTool( async () => ctx.format.ok( { ok: true } ) );
		const handler = dispatch( tool, ctx );
		const result = await handler( { x: 'y' } );
		expect( result.isError ).toBeUndefined();
	} );

	it( 'classifies thrown errors and produces an error result', async () => {
		const ctx = fakeContext();
		const tool = noopTool( async () => {
			throw createMockMwnError( 'permissiondenied' );
		} );
		const handler = dispatch( tool, ctx );
		const result = await handler( { x: 'y' } );
		expect( result.isError ).toBe( true );
		const envelope = JSON.parse(
			( result.content[ 0 ] as { text: string } ).text
		);
		expect( envelope.category ).toBe( 'permission_denied' );
		expect( envelope.code ).toBe( 'permissiondenied' );
	} );

	it( 'applies special case for nosuchsection', async () => {
		const ctx = fakeContext();
		const tool = noopTool( async () => {
			throw Object.assign( new Error( 'section 7 does not exist' ), {
				code: 'nosuchsection'
			} );
		} );
		( tool as { name: string } ).name = 'update-page';
		const result = await dispatch( tool, ctx )( { x: 'y' } );
		const envelope = JSON.parse(
			( result.content[ 0 ] as { text: string } ).text
		);
		expect( envelope.message ).toBe( 'Section 7 does not exist' );
		expect( envelope.code ).toBe( 'nosuchsection' );
	} );

	it( 'logs the failure with tool name and category', async () => {
		const logger = {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
			debug: vi.fn()
		};
		const ctx = fakeContext( { logger } );
		const tool = noopTool( async () => {
			throw new Error( 'boom' );
		} );
		await dispatch( tool, ctx )( { x: 'y' } );
		expect( logger.error ).toHaveBeenCalledWith(
			'Tool failed',
			expect.objectContaining( { tool: 'get-page' } )
		);
	} );

	it( 'wraps untailored messages with "Failed to <verb>:" prefix', async () => {
		const ctx = fakeContext();
		const tool = noopTool( async () => {
			throw new Error( 'boom' );
		} );
		( tool as { name: string; failureVerb: string } ).name = 'update-page';
		( tool as { name: string; failureVerb: string } ).failureVerb = 'update page';
		const result = await dispatch( tool, ctx )( { x: 'y' } );
		const envelope = JSON.parse(
			( result.content[ 0 ] as { text: string } ).text
		);
		expect( envelope.message ).toBe( 'Failed to update page: boom' );
	} );
} );
