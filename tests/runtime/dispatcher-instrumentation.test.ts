import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { dispatch } from '../../src/runtime/dispatcher.js';
import type { Tool } from '../../src/runtime/tool.js';
import { fakeContext } from '../helpers/fakeContext.js';
import {
	registerServer,
	clearRegisteredServers
} from '../../src/runtime/logger.js';
import { runtimeTokenStore } from '../../src/transport/requestContext.js';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

// Capture only the structured "tool_call" events the dispatcher emits via
// emitTelemetryEvent. Other lines (e.g. "Tool failed" prose from logger.error)
// also go to stderr; we filter those out by event type.
function captureToolCallLine( spy: ReturnType<typeof vi.spyOn> ): Record<string, unknown> {
	const events = spy.mock.calls
		.map( ( c ) => String( c[ 0 ] ) )
		.filter( ( s ) => s.startsWith( '{' ) )
		.map( ( s ) => JSON.parse( s.slice( 0, -1 ) ) as Record<string, unknown> )
		.filter( ( e ) => e.event === 'tool_call' );
	expect( events.length ).toBeGreaterThan( 0 );
	return events[ events.length - 1 ];
}

function buildTool<TArgs extends z.ZodRawShape>(
	overrides: Partial<Tool<TArgs>> & { inputSchema: TArgs; handle: Tool<TArgs>[ 'handle' ] }
): Tool<TArgs> {
	return {
		name: 'get-page',
		description: 'd',
		annotations: {
			title: 't',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		...overrides
	} as Tool<TArgs>;
}

function okResult( payload: unknown = { ok: true } ): CallToolResult {
	return {
		content: [ { type: 'text', text: JSON.stringify( payload ) } ],
		structuredContent: payload as Record<string, unknown>
	};
}

function errResult( category: string, message: string ): CallToolResult {
	return {
		content: [ { type: 'text', text: JSON.stringify( { category, message } ) } ],
		isError: true
	};
}

describe( 'dispatcher telemetry', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stderrSpy.mockRestore();
		clearRegisteredServers();
	} );

	it( 'emits a success line with tool, outcome, duration_ms, level=info', async () => {
		const tool = buildTool( {
			name: 'get-page',
			inputSchema: { title: z.string() },
			handle: async () => okResult()
		} );
		const ctx = fakeContext();
		await dispatch( tool, ctx )( { title: 'Main Page' } );

		const line = captureToolCallLine( stderrSpy );
		expect( line.event ).toBe( 'tool_call' );
		expect( line.tool ).toBe( 'get-page' );
		expect( line.outcome ).toBe( 'success' );
		expect( line.level ).toBe( 'info' );
		expect( typeof line.duration_ms ).toBe( 'number' );
		expect( Number.isInteger( line.duration_ms ) ).toBe( true );
	} );

	it( 'includes the wiki key from selection.getCurrent()', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		const line = captureToolCallLine( stderrSpy );
		expect( typeof line.wiki ).toBe( 'string' );
	} );

	it( 'includes target when the descriptor declares a target extractor', async () => {
		const tool = buildTool( {
			inputSchema: { title: z.string() },
			target: ( a ) => a.title,
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( { title: 'Main Page' } );

		expect( captureToolCallLine( stderrSpy ).target ).toBe( 'Main Page' );
	} );

	it( 'omits target when the descriptor has no target extractor', async () => {
		const tool = buildTool( {
			name: 'set-wiki',
			inputSchema: {},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( 'target' in captureToolCallLine( stderrSpy ) ).toBe( false );
	} );

	it( 'omits target when the extractor returns empty string', async () => {
		const tool = buildTool( {
			inputSchema: { title: z.string().optional() },
			target: ( a ) => a.title ?? '',
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( 'target' in captureToolCallLine( stderrSpy ) ).toBe( false );
	} );

	it( 'omits target when the extractor throws', async () => {
		const tool = buildTool( {
			inputSchema: {},
			target: () => {
				throw new Error( 'oops' );
			},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( 'target' in captureToolCallLine( stderrSpy ) ).toBe( false );
	} );

	it.each( [
		[ 'not_found', 'warning' ],
		[ 'invalid_input', 'warning' ],
		[ 'permission_denied', 'warning' ],
		[ 'conflict', 'warning' ],
		[ 'authentication', 'warning' ],
		[ 'rate_limited', 'warning' ],
		[ 'upstream_failure', 'error' ]
	] )( 'maps category %s to level %s on errorResult from handler', async ( category, level ) => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => errResult( category, 'msg' )
		} );
		await dispatch( tool, fakeContext() )( {} );

		const line = captureToolCallLine( stderrSpy );
		expect( line.outcome ).toBe( category );
		expect( line.level ).toBe( level );
		expect( line.error_message ).toBe( 'msg' );
	} );

	it( 'classifies thrown errors and reports upstream_status when present', async () => {
		const err = Object.assign( new Error( 'boom' ), {
			code: 'ratelimited',
			response: { status: 429 }
		} );
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => {
				throw err;
			}
		} );
		await dispatch( tool, fakeContext() )( {} );

		const line = captureToolCallLine( stderrSpy );
		expect( line.outcome ).toBe( 'rate_limited' );
		expect( line.upstream_status ).toBe( 429 );
		expect( typeof line.error_message ).toBe( 'string' );
	} );

	it( 'detects truncation when the result payload contains a truncation field', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult( {
				source: 'partial',
				truncation: { reason: 'content-truncated' }
			} )
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( captureToolCallLine( stderrSpy ).truncated ).toBe( true );
	} );

	it( 'reports truncated:false when the result has no truncation field', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult( { source: 'fine' } )
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( captureToolCallLine( stderrSpy ).truncated ).toBe( false );
	} );

	it( 'sets caller=anonymous when no bearer is in context', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( captureToolCallLine( stderrSpy ).caller ).toBe( 'anonymous' );
	} );

	it( 'sets caller=sha256:<12 hex> when a bearer is in context', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await runtimeTokenStore.run( { runtimeToken: 'secret-token' }, async () => {
			await dispatch( tool, fakeContext() )( {} );
		} );

		const caller = captureToolCallLine( stderrSpy ).caller;
		expect( typeof caller ).toBe( 'string' );
		expect( caller ).toMatch( /^sha256:[0-9a-f]{12}$/ );
	} );

	it( 'includes session_id (first 12 hex chars, dashes stripped) when present in context', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await runtimeTokenStore.run(
			{ sessionId: 'f4e1d2c3-b4a5-dead-beef-abcdef012345' },
			async () => {
				await dispatch( tool, fakeContext() )( {} );
			}
		);

		expect( captureToolCallLine( stderrSpy ).session_id ).toBe( 'f4e1d2c3b4a5' );
	} );

	it( 'omits session_id outside any context', async () => {
		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( 'session_id' in captureToolCallLine( stderrSpy ) ).toBe( false );
	} );

	it( 'does not broadcast tool_call events to connected MCP clients', async () => {
		const fakeServer = {
			sendLoggingMessage: vi.fn().mockResolvedValue( undefined ),
			server: { onclose: undefined }
		};
		registerServer( fakeServer as unknown as Parameters<typeof registerServer>[ 0 ] );

		const tool = buildTool( {
			inputSchema: {},
			handle: async () => okResult()
		} );
		await dispatch( tool, fakeContext() )( {} );

		expect( fakeServer.sendLoggingMessage ).not.toHaveBeenCalled();
	} );
} );
