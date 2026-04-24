import { describe, it, expect } from 'vitest';
import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { extractBearerToken, resolveMcpHostValidation } from '../../src/streamableHttp.js';

function req( authorization: string | undefined ): Request {
	return { headers: { authorization } } as unknown as Request;
}

describe( 'extractBearerToken', () => {
	it( 'returns the token for a standard Bearer header', () => {
		expect( extractBearerToken( req( 'Bearer abc123' ) ) ).toBe( 'abc123' );
	} );
	it( 'is case-insensitive on the scheme', () => {
		expect( extractBearerToken( req( 'bearer abc123' ) ) ).toBe( 'abc123' );
		expect( extractBearerToken( req( 'BEARER abc123' ) ) ).toBe( 'abc123' );
	} );
	it( 'trims whitespace around the token', () => {
		expect( extractBearerToken( req( 'Bearer   abc123  ' ) ) ).toBe( 'abc123' );
	} );
	it( 'returns undefined for whitespace-only tokens', () => {
		expect( extractBearerToken( req( 'Bearer   \t' ) ) ).toBeUndefined();
		expect( extractBearerToken( req( 'Bearer ' ) ) ).toBeUndefined();
	} );
	it( 'returns undefined when header is missing', () => {
		expect( extractBearerToken( req( undefined ) ) ).toBeUndefined();
	} );
	it( 'returns undefined for non-Bearer schemes', () => {
		expect( extractBearerToken( req( 'Basic xyz' ) ) ).toBeUndefined();
		expect( extractBearerToken( req( 'Digest xyz' ) ) ).toBeUndefined();
	} );
	it( 'takes the first well-formed value from comma-joined duplicate headers', () => {
		expect( extractBearerToken( req( 'Bearer abc, Bearer def' ) ) ).toBe( 'abc' );
	} );
	it( 'returns undefined if the first comma-joined value is not Bearer', () => {
		expect( extractBearerToken( req( ', Bearer abc' ) ) ).toBeUndefined();
		expect( extractBearerToken( req( 'Basic xyz, Bearer abc' ) ) ).toBeUndefined();
	} );
} );

describe( 'host validation (scoped to /mcp)', () => {
	function buildApp( host: string, allowedHosts?: string[] ): Express {
		const app = express();
		app.use( express.json() );
		const validation = resolveMcpHostValidation( host, allowedHosts );
		if ( validation ) {
			app.use( '/mcp', validation );
		}
		app.post( '/mcp', ( _req, res ) => {
			res.status( 200 ).json( { ok: true } );
		} );
		app.get( '/health', ( _req, res ) => {
			res.status( 200 ).json( { status: 'ok' } );
		} );
		return app;
	}

	it( 'accepts localhost Host when bound to 127.0.0.1 with default allowlist', async () => {
		const res = await request( buildApp( '127.0.0.1' ) )
			.post( '/mcp' )
			.set( 'Host', '127.0.0.1:3000' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );

	it( 'rejects non-local Host when bound to 127.0.0.1 with default allowlist', async () => {
		const res = await request( buildApp( '127.0.0.1' ) )
			.post( '/mcp' )
			.set( 'Host', 'evil.example:3000' )
			.send( {} );
		expect( res.status ).toBe( 403 );
		expect( res.body?.error?.message ).toMatch( /Invalid Host/ );
	} );

	it( 'accepts configured Host when explicit allowlist is set', async () => {
		const res = await request( buildApp( '0.0.0.0', [ 'wiki.example.org' ] ) )
			.post( '/mcp' )
			.set( 'Host', 'wiki.example.org' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );

	it( 'rejects unlisted Host when explicit allowlist is set', async () => {
		const res = await request( buildApp( '0.0.0.0', [ 'wiki.example.org' ] ) )
			.post( '/mcp' )
			.set( 'Host', 'other.example' )
			.send( {} );
		expect( res.status ).toBe( 403 );
		expect( res.body?.error?.message ).toMatch( /Invalid Host/ );
	} );

	it( 'accepts any Host when bound to 0.0.0.0 without allowlist', async () => {
		const res = await request( buildApp( '0.0.0.0' ) )
			.post( '/mcp' )
			.set( 'Host', 'anything.example' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );

	it( 'leaves /health reachable even when an explicit allowlist is set', async () => {
		const res = await request( buildApp( '0.0.0.0', [ 'wiki.example.org' ] ) )
			.get( '/health' )
			.set( 'Host', 'localhost:8080' );
		expect( res.status ).toBe( 200 );
		expect( res.body ).toEqual( { status: 'ok' } );
	} );
} );
