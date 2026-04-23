import { describe, it, expect, vi } from 'vitest';
import { redactAuthorizationHeader, wrapMwnErrors } from '../../src/common/mwnErrorSanitizer.js';

describe( 'redactAuthorizationHeader', () => {
	it( 'redacts Authorization on .request.headers but preserves other fields', () => {
		const err = Object.assign( new Error( 'boom' ), {
			request: {
				method: 'POST',
				path: '/w/api.php',
				headers: { Authorization: 'Bearer secret123', 'User-Agent': 'x' }
			}
		} );
		redactAuthorizationHeader( err );
		expect( ( err as any ).request.headers.Authorization ).toBe( '[REDACTED]' );
		expect( ( err as any ).request.headers[ 'User-Agent' ] ).toBe( 'x' );
		expect( ( err as any ).request.method ).toBe( 'POST' );
		expect( ( err as any ).request.path ).toBe( '/w/api.php' );
	} );

	it( 'redacts Authorization on .config.headers', () => {
		const err = Object.assign( new Error( 'boom' ), {
			config: { headers: { Authorization: 'Bearer secret123' } }
		} );
		redactAuthorizationHeader( err );
		expect( ( err as any ).config.headers.Authorization ).toBe( '[REDACTED]' );
	} );

	it( 'redacts Authorization on .response.config.headers if present', () => {
		const err = Object.assign( new Error( 'boom' ), {
			response: {
				status: 500,
				config: { headers: { Authorization: 'Bearer secret123' } }
			}
		} );
		redactAuthorizationHeader( err );
		expect( ( err as any ).response.config.headers.Authorization ).toBe( '[REDACTED]' );
		expect( ( err as any ).response.status ).toBe( 500 );
	} );

	it( 'redacts token substring in error message when token is supplied', () => {
		const err = new Error( 'failed with token Bearer secret123 somewhere' );
		redactAuthorizationHeader( err, 'secret123' );
		expect( err.message ).toBe( 'failed with token Bearer [REDACTED] somewhere' );
	} );

	it( 'does nothing when no Authorization header present', () => {
		const err = Object.assign( new Error( 'boom' ), {
			request: { method: 'GET', headers: { 'User-Agent': 'x' } }
		} );
		redactAuthorizationHeader( err );
		expect( ( err as any ).request.headers[ 'User-Agent' ] ).toBe( 'x' );
	} );

	it( 'is a no-op for non-Error inputs', () => {
		expect( () => redactAuthorizationHeader( null ) ).not.toThrow();
		expect( () => redactAuthorizationHeader( 'string' ) ).not.toThrow();
		expect( () => redactAuthorizationHeader( { headers: {} } ) ).not.toThrow();
	} );
} );

describe( 'wrapMwnErrors', () => {
	it( 'redacts Authorization on errors thrown by async methods', async () => {
		const target = {
			request: vi.fn().mockRejectedValue(
				Object.assign( new Error( 'api error' ), {
					request: { headers: { Authorization: 'Bearer secret123' } }
				} )
			)
		};
		const wrapped = wrapMwnErrors( target ) as typeof target;
		await expect( wrapped.request() ).rejects.toMatchObject( {
			message: 'api error',
			request: { headers: { Authorization: '[REDACTED]' } }
		} );
	} );

	it( 'redacts Authorization on errors thrown by sync methods', () => {
		const target = {
			syncFail: vi.fn( () => {
				throw Object.assign( new Error( 'sync' ), {
					request: { headers: { Authorization: 'Bearer secret123' } }
				} );
			} )
		};
		const wrapped = wrapMwnErrors( target ) as typeof target;
		expect( () => wrapped.syncFail() ).toThrow( 'sync' );
		try {
			wrapped.syncFail();
		} catch ( e ) {
			expect( ( e as any ).request.headers.Authorization ).toBe( '[REDACTED]' );
		}
	} );

	it( 'redacts token substrings in message when token supplied', async () => {
		const target = {
			request: vi.fn().mockRejectedValue( new Error( 'fail with Bearer secret123' ) )
		};
		const wrapped = wrapMwnErrors( target, 'secret123' ) as typeof target;
		await expect( wrapped.request() ).rejects.toThrow( 'fail with Bearer [REDACTED]' );
	} );

	it( 'passes through non-function property access unchanged', () => {
		const target = {
			cookieJar: null,
			Category: { members: vi.fn() }
		};
		const wrapped = wrapMwnErrors( target ) as typeof target;
		expect( wrapped.cookieJar ).toBeNull();
		expect( wrapped.Category ).toBe( target.Category );
	} );

	it( 'preserves this binding for methods that call other methods', async () => {
		const target = {
			inner: vi.fn().mockResolvedValue( 'ok' ),
			outer() {
				return ( this as any ).inner();
			}
		};
		const wrapped = wrapMwnErrors( target ) as typeof target;
		await expect( wrapped.outer() ).resolves.toBe( 'ok' );
	} );

	it( 'passes through successful return values', async () => {
		const target = { request: vi.fn().mockResolvedValue( { ok: true } ) };
		const wrapped = wrapMwnErrors( target ) as typeof target;
		await expect( wrapped.request() ).resolves.toEqual( { ok: true } );
	} );
} );
