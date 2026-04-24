import { describe, it, expect } from 'vitest';
import { runtimeTokenStore, getRuntimeToken } from '../../src/common/requestContext.js';

describe( 'requestContext', () => {

	it( 'returns undefined outside a run', () => {
		expect( getRuntimeToken() ).toBeUndefined();
	} );

	it( 'returns the token inside a run', () => {
		runtimeTokenStore.run( { runtimeToken: 'abc' }, () => {
			expect( getRuntimeToken() ).toBe( 'abc' );
		} );
	} );

	it( 'returns undefined when runtimeToken is not set in the context', () => {
		runtimeTokenStore.run( {}, () => {
			expect( getRuntimeToken() ).toBeUndefined();
		} );
	} );

	it( 'inner run overrides outer token', () => {
		runtimeTokenStore.run( { runtimeToken: 'outer' }, () => {
			expect( getRuntimeToken() ).toBe( 'outer' );
			runtimeTokenStore.run( { runtimeToken: 'inner' }, () => {
				expect( getRuntimeToken() ).toBe( 'inner' );
			} );
			expect( getRuntimeToken() ).toBe( 'outer' );
		} );
	} );

	it( 'isolates concurrent runs', async () => {
		const results: string[] = [];

		await Promise.all( [
			runtimeTokenStore.run( { runtimeToken: 'token-a' }, async () => {
				await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
				results.push( `a:${ getRuntimeToken() }` );
			} ),
			runtimeTokenStore.run( { runtimeToken: 'token-b' }, async () => {
				await new Promise( ( resolve ) => setTimeout( resolve, 5 ) );
				results.push( `b:${ getRuntimeToken() }` );
			} )
		] );

		expect( results ).toContain( 'a:token-a' );
		expect( results ).toContain( 'b:token-b' );
	} );

} );
