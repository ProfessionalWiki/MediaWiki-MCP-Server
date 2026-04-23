import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { extractBearerToken } from '../../src/streamableHttp.js';

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
