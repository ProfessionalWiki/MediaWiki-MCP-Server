import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveShutdownGrace } from '../../src/runtime/shutdown.js';

describe( 'resolveShutdownGrace', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		stderrSpy.mockRestore();
	} );

	function warningLines(): string[] {
		return stderrSpy.mock.calls
			.map( ( c ) => String( c[ 0 ] ) )
			.filter( ( s ) => s.includes( '"level":"warning"' ) );
	}

	it( 'defaults to 10000 when unset', () => {
		expect( resolveShutdownGrace( {} ) ).toBe( 10_000 );
		expect( warningLines() ).toHaveLength( 0 );
	} );

	it( 'parses a valid integer string', () => {
		expect( resolveShutdownGrace( { MCP_SHUTDOWN_GRACE_MS: '5000' } ) ).toBe( 5_000 );
		expect( warningLines() ).toHaveLength( 0 );
	} );

	it( 'accepts zero (immediate exit, no drain wait)', () => {
		expect( resolveShutdownGrace( { MCP_SHUTDOWN_GRACE_MS: '0' } ) ).toBe( 0 );
	} );

	it.each( [
		[ 'not-a-number' ],
		[ '-1' ],
		[ '1.5' ],
		[ '600001' ],
		[ '' ]
	] )( 'falls back with a warning for %s', ( v ) => {
		expect( resolveShutdownGrace( { MCP_SHUTDOWN_GRACE_MS: v } ) ).toBe( 10_000 );
		const lines = warningLines();
		expect( lines ).toHaveLength( 1 );
		expect( lines[ 0 ] ).toContain( v );
	} );
} );
