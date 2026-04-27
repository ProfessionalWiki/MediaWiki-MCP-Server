import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: () => ( { key: 'test-wiki' } )
	}
} ) );

import {
	instrumentToolCall,
	type TargetExtractor
} from '../../src/tools/instrument.js';
import { runtimeTokenStore } from '../../src/common/requestContext.js';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

function captureLine( spy: ReturnType<typeof vi.spyOn> ): Record<string, unknown> {
	const calls = spy.mock.calls;
	expect( calls.length ).toBeGreaterThan( 0 );
	const last = String( calls[ calls.length - 1 ][ 0 ] );
	return JSON.parse( last.slice( 0, -1 ) ) as Record<string, unknown>;
}

function okResult( payload: unknown = { ok: true } ): CallToolResult {
	return { content: [ { type: 'text', text: JSON.stringify( payload ) } ] };
}

function errResult( category: string, message: string ): CallToolResult {
	return {
		content: [ { type: 'text', text: JSON.stringify( { category, message } ) } ],
		isError: true
	};
}

describe( 'instrumentToolCall', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stderrSpy.mockRestore();
	} );

	it( 'emits a success line with tool, outcome, duration_ms, level=info', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( { title: 'Main Page' } );

		const line = captureLine( stderrSpy );
		expect( line.event ).toBe( 'tool_call' );
		expect( line.tool ).toBe( 'get-page' );
		expect( line.outcome ).toBe( 'success' );
		expect( line.level ).toBe( 'info' );
		expect( typeof line.duration_ms ).toBe( 'number' );
		expect( Number.isInteger( line.duration_ms ) ).toBe( true );
	} );

	it( 'includes the wiki key from wikiService.getCurrent()', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		const line = captureLine( stderrSpy );
		expect( typeof line.wiki ).toBe( 'string' );
	} );

	it( 'includes target when the extractor returns a non-empty string', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const target: TargetExtractor<{ title: string }> = ( a ) => a.title;
		const wrapped = instrumentToolCall( 'get-page', handler, target );

		await wrapped( { title: 'Main Page' } );

		expect( captureLine( stderrSpy ).target ).toBe( 'Main Page' );
	} );

	it( 'omits target when no extractor is supplied', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'set-wiki', handler );

		await wrapped( {} );

		expect( 'target' in captureLine( stderrSpy ) ).toBe( false );
	} );

	it( 'omits target when the extractor returns empty string', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const target: TargetExtractor<{ title?: string }> = ( a ) => a.title ?? '';
		const wrapped = instrumentToolCall( 'get-page', handler, target );

		await wrapped( {} );

		expect( 'target' in captureLine( stderrSpy ) ).toBe( false );
	} );

	it.each( [
		[ 'not_found', 'warning' ],
		[ 'invalid_input', 'warning' ],
		[ 'permission_denied', 'warning' ],
		[ 'conflict', 'warning' ],
		[ 'authentication', 'warning' ],
		[ 'rate_limited', 'warning' ],
		[ 'upstream_failure', 'error' ]
	] )( 'maps category %s to level %s on errorResult', async ( category, level ) => {
		const handler = vi.fn().mockResolvedValue( errResult( category, 'msg' ) );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		const line = captureLine( stderrSpy );
		expect( line.outcome ).toBe( category );
		expect( line.level ).toBe( level );
		expect( line.error_message ).toBe( 'msg' );
	} );

	it( 'classifies thrown errors and re-throws', async () => {
		const err = Object.assign( new Error( 'boom' ), {
			code: 'ratelimited',
			response: { status: 429 }
		} );
		const handler = vi.fn().mockRejectedValue( err );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await expect( wrapped( {} ) ).rejects.toBe( err );

		const line = captureLine( stderrSpy );
		expect( line.outcome ).toBe( 'rate_limited' );
		expect( line.upstream_status ).toBe( 429 );
		expect( typeof line.error_message ).toBe( 'string' );
	} );

	it( 'detects truncation when the result payload contains a truncation field', async () => {
		const truncatedPayload = {
			source: 'partial',
			truncation: { reason: 'content-truncated' }
		};
		const handler = vi.fn().mockResolvedValue( okResult( truncatedPayload ) );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		expect( captureLine( stderrSpy ).truncated ).toBe( true );
	} );

	it( 'reports truncated:false when the result has no truncation field', async () => {
		const handler = vi.fn().mockResolvedValue( okResult( { source: 'fine' } ) );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		expect( captureLine( stderrSpy ).truncated ).toBe( false );
	} );

	it( 'sets caller=anonymous when no bearer is in context', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		expect( captureLine( stderrSpy ).caller ).toBe( 'anonymous' );
	} );

	it( 'sets caller=sha256:<12 hex> when a bearer is in context', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await runtimeTokenStore.run( { runtimeToken: 'secret-token' }, async () => {
			await wrapped( {} );
		} );

		const caller = captureLine( stderrSpy ).caller;
		expect( typeof caller ).toBe( 'string' );
		expect( caller ).toMatch( /^sha256:[0-9a-f]{12}$/ );
	} );

	it( 'includes session_id (first 12 chars) when present in context', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await runtimeTokenStore.run(
			{ sessionId: 'f4e1d2c3b4a5deadbeef' },
			async () => { await wrapped( {} ); }
		);

		expect( captureLine( stderrSpy ).session_id ).toBe( 'f4e1d2c3b4a5' );
	} );

	it( 'omits session_id outside any context', async () => {
		const handler = vi.fn().mockResolvedValue( okResult() );
		const wrapped = instrumentToolCall( 'get-page', handler );

		await wrapped( {} );

		expect( 'session_id' in captureLine( stderrSpy ) ).toBe( false );
	} );
} );
