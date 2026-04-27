import { describe, it, expect } from 'vitest';
import {
	evaluateBearerGuard,
	hasStaticCredentials,
	classifyAuthShape
} from '../../src/common/bearerGuard.js';
import type { WikiConfig } from '../../src/common/config.js';

function wiki( overrides: Partial<WikiConfig> = {} ): WikiConfig {
	return {
		sitename: 'Example',
		server: 'https://example.org',
		articlepath: '/wiki',
		scriptpath: '/w',
		...overrides
	};
}

describe( 'hasStaticCredentials', () => {
	it( 'is false for a wiki with no credential fields', () => {
		expect( hasStaticCredentials( wiki() ) ).toBe( false );
	} );

	it.each( [ null, '' ] )( 'is false when token is %p', ( value ) => {
		expect( hasStaticCredentials( wiki( { token: value } ) ) ).toBe( false );
	} );

	it( 'is true when token is a non-empty string', () => {
		expect( hasStaticCredentials( wiki( { token: 'abc' } ) ) ).toBe( true );
	} );

	it( 'is true when both username and password are non-empty strings', () => {
		expect( hasStaticCredentials( wiki( { username: 'u', password: 'p' } ) ) ).toBe( true );
	} );

	it( 'is false when only username is set', () => {
		expect( hasStaticCredentials( wiki( { username: 'u' } ) ) ).toBe( false );
	} );

	it( 'is false when only password is set', () => {
		expect( hasStaticCredentials( wiki( { password: 'p' } ) ) ).toBe( false );
	} );

	it( 'is false when username or password is empty string', () => {
		expect( hasStaticCredentials( wiki( { username: '', password: 'p' } ) ) ).toBe( false );
		expect( hasStaticCredentials( wiki( { username: 'u', password: '' } ) ) ).toBe( false );
	} );

	it( 'is true when token and bot-password fields are all set', () => {
		expect( hasStaticCredentials( wiki( { token: 't', username: 'u', password: 'p' } ) ) ).toBe( true );
	} );
} );

describe( 'evaluateBearerGuard', () => {
	it( 'returns ok when there are no wikis', () => {
		expect( evaluateBearerGuard( {}, {} ) ).toEqual( { kind: 'ok' } );
	} );

	it( 'returns ok when no wiki has credentials', () => {
		const wikis = { a: wiki(), b: wiki( { token: null } ) };
		expect( evaluateBearerGuard( wikis, {} ) ).toEqual( { kind: 'ok' } );
	} );

	it( 'returns block when a wiki has a token and the override env is unset', () => {
		const wikis = { a: wiki( { token: 'abc' } ) };
		expect( evaluateBearerGuard( wikis, {} ) ).toEqual( {
			kind: 'block',
			wikis: [ 'a' ]
		} );
	} );

	it( 'returns block when a wiki has bot-password credentials', () => {
		const wikis = { a: wiki( { username: 'u', password: 'p' } ) };
		expect( evaluateBearerGuard( wikis, {} ) ).toEqual( {
			kind: 'block',
			wikis: [ 'a' ]
		} );
	} );

	it( 'returns override when MCP_ALLOW_STATIC_FALLBACK is exactly "true"', () => {
		const wikis = { a: wiki( { token: 'abc' } ) };
		expect( evaluateBearerGuard( wikis, { MCP_ALLOW_STATIC_FALLBACK: 'true' } ) ).toEqual( {
			kind: 'override',
			wikis: [ 'a' ]
		} );
	} );

	it.each( [ 'TRUE', '1', 'yes', ' true ', '' ] )(
		'returns block when MCP_ALLOW_STATIC_FALLBACK is %p (not exactly "true")',
		( value ) => {
			const wikis = { a: wiki( { token: 'abc' } ) };
			expect( evaluateBearerGuard( wikis, { MCP_ALLOW_STATIC_FALLBACK: value } ) ).toEqual( {
				kind: 'block',
				wikis: [ 'a' ]
			} );
		}
	);

	it( 'lists only credentialed wikis, in insertion order', () => {
		const wikis = {
			a: wiki(),
			b: wiki( { token: 'abc' } ),
			c: wiki(),
			d: wiki( { username: 'u', password: 'p' } )
		};
		expect( evaluateBearerGuard( wikis, {} ) ).toEqual( {
			kind: 'block',
			wikis: [ 'b', 'd' ]
		} );
	} );

	it( 'returns ok regardless of MCP_ALLOW_STATIC_FALLBACK when no wiki has credentials', () => {
		expect( evaluateBearerGuard( {}, { MCP_ALLOW_STATIC_FALLBACK: 'true' } ) ).toEqual( {
			kind: 'ok'
		} );
	} );
} );

describe( 'classifyAuthShape', () => {
	const baseWiki: WikiConfig = {
		sitename: 'X',
		server: 'https://x',
		articlepath: '/wiki',
		scriptpath: '/w'
	};

	it( 'returns static-credential when any wiki has a token', () => {
		const wikis = { a: { ...baseWiki, token: 't' } };
		expect( classifyAuthShape( wikis, 'http' ) ).toBe( 'static-credential' );
		expect( classifyAuthShape( wikis, 'stdio' ) ).toBe( 'static-credential' );
	} );

	it( 'returns static-credential when any wiki has username and password', () => {
		const wikis = { a: { ...baseWiki, username: 'u', password: 'p' } };
		expect( classifyAuthShape( wikis, 'http' ) ).toBe( 'static-credential' );
	} );

	it( 'returns bearer-passthrough on http when no static creds', () => {
		const wikis = { a: baseWiki };
		expect( classifyAuthShape( wikis, 'http' ) ).toBe( 'bearer-passthrough' );
	} );

	it( 'returns anonymous on stdio when no static creds', () => {
		const wikis = { a: baseWiki };
		expect( classifyAuthShape( wikis, 'stdio' ) ).toBe( 'anonymous' );
	} );

	it( 'is unaffected by partial credentials (username only or password only)', () => {
		const wikisU = { a: { ...baseWiki, username: 'u' } };
		const wikisP = { a: { ...baseWiki, password: 'p' } };
		expect( classifyAuthShape( wikisU, 'http' ) ).toBe( 'bearer-passthrough' );
		expect( classifyAuthShape( wikisP, 'http' ) ).toBe( 'bearer-passthrough' );
	} );
} );
