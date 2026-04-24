import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { extractBearerToken } from '../../src/streamableHttp.js';
import request from 'supertest';
/* eslint-disable n/no-missing-import */
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
/* eslint-enable n/no-missing-import */

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

describe( 'host validation (createMcpExpressApp integration)', () => {
	function buildApp(
		options: Parameters<typeof createMcpExpressApp>[ 0 ]
	): ReturnType<typeof createMcpExpressApp> {
		const app = createMcpExpressApp( options );
		app.post( '/mcp', ( _req, res ) => {
			res.status( 200 ).json( { ok: true } );
		} );
		return app;
	}

	it( 'accepts localhost Host when bound to 127.0.0.1 with default allowlist', async () => {
		const app = buildApp( { host: '127.0.0.1' } );
		const res = await request( app )
			.post( '/mcp' )
			.set( 'Host', '127.0.0.1:3000' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );

	it( 'rejects non-local Host when bound to 127.0.0.1 with default allowlist', async () => {
		const app = buildApp( { host: '127.0.0.1' } );
		const res = await request( app )
			.post( '/mcp' )
			.set( 'Host', 'evil.example:3000' )
			.send( {} );
		expect( res.status ).toBe( 403 );
		expect( res.body?.error?.message ).toMatch( /Invalid Host/ );
	} );

	it( 'accepts configured Host when explicit allowlist is set', async () => {
		const app = buildApp( {
			host: '0.0.0.0',
			allowedHosts: [ 'wiki.example.org' ]
		} );
		const res = await request( app )
			.post( '/mcp' )
			.set( 'Host', 'wiki.example.org' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );

	it( 'rejects unlisted Host when explicit allowlist is set', async () => {
		const app = buildApp( {
			host: '0.0.0.0',
			allowedHosts: [ 'wiki.example.org' ]
		} );
		const res = await request( app )
			.post( '/mcp' )
			.set( 'Host', 'other.example' )
			.send( {} );
		expect( res.status ).toBe( 403 );
		expect( res.body?.error?.message ).toMatch( /Invalid Host/ );
	} );

	it( 'accepts any Host when bound to 0.0.0.0 without allowlist', async () => {
		const app = buildApp( { host: '0.0.0.0' } );
		const res = await request( app )
			.post( '/mcp' )
			.set( 'Host', 'anything.example' )
			.send( {} );
		expect( res.status ).toBe( 200 );
	} );
} );
