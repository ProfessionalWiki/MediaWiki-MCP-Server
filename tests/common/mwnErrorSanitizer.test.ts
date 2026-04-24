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

	it( 'redacts lowercase authorization header (axios-normalised)', () => {
		const err = Object.assign( new Error( 'boom' ), {
			config: { headers: { authorization: 'Bearer secret123' } }
		} );
		redactAuthorizationHeader( err );
		expect( ( err as any ).config.headers.authorization ).toBe( '[REDACTED]' );
	} );

	it( 'keeps the Authorization field present (redacts, does not delete)', () => {
		const err = Object.assign( new Error( 'boom' ), {
			request: { headers: { Authorization: 'Bearer secret123' } }
		} );
		redactAuthorizationHeader( err );
		expect( 'Authorization' in ( err as any ).request.headers ).toBe( true );
		expect( ( err as any ).request.headers.Authorization ).toBe( '[REDACTED]' );
	} );

	it( 'redacts token substring in err.stack when token supplied', () => {
		const err = new Error( 'plain' );
		err.stack = 'Error: something went wrong with Bearer secret123\n    at X';
		redactAuthorizationHeader( err, 'secret123' );
		expect( err.stack ).toBe( 'Error: something went wrong with Bearer [REDACTED]\n    at X' );
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

	it( 'redacts Authorization on errors thrown during async iteration', async () => {
		async function* failing(): AsyncGenerator<{ page: string }> {
			yield { page: 'first' };
			throw Object.assign( new Error( 'page fetch failed' ), {
				request: { headers: { Authorization: 'Bearer secret123' } }
			} );
		}
		const target = { readGen: vi.fn( () => failing() ) };
		const wrapped = wrapMwnErrors( target ) as typeof target;

		const iter = wrapped.readGen();
		await expect( iter.next() ).resolves.toEqual( { value: { page: 'first' }, done: false } );
		await expect( iter.next() ).rejects.toMatchObject( {
			request: { headers: { Authorization: '[REDACTED]' } }
		} );
	} );

	it( 'passes through normal async iteration values unchanged', async () => {
		async function* ok(): AsyncGenerator<number> {
			yield 1;
			yield 2;
			yield 3;
		}
		const target = { gen: vi.fn( () => ok() ) };
		const wrapped = wrapMwnErrors( target ) as typeof target;

		const results: number[] = [];
		for await ( const v of wrapped.gen() ) {
			results.push( v );
		}
		expect( results ).toEqual( [ 1, 2, 3 ] );
	} );

	it( 'forwards return() to the underlying iterator for early termination cleanup', async () => {
		let cleanedUp = false;
		async function* withCleanup(): AsyncGenerator<number> {
			try {
				yield 1;
				yield 2;
			} finally {
				cleanedUp = true;
			}
		}
		const target = { gen: vi.fn( () => withCleanup() ) };
		const wrapped = wrapMwnErrors( target ) as typeof target;

		for await ( const v of wrapped.gen() ) {
			if ( v === 1 ) {
				break;
			}
		}
		expect( cleanedUp ).toBe( true );
	} );
} );
