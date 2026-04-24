import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveHttpConfig } from '../../src/common/httpConfig.js';

describe( 'resolveHttpConfig', () => {
	afterEach( () => {
		vi.unstubAllEnvs();
	} );

	describe( 'host', () => {
		it( 'defaults to 127.0.0.1 when MCP_BIND is unset', () => {
			expect( resolveHttpConfig().host ).toBe( '127.0.0.1' );
		} );

		it( 'defaults to 127.0.0.1 when MCP_BIND is empty', () => {
			vi.stubEnv( 'MCP_BIND', '' );
			expect( resolveHttpConfig().host ).toBe( '127.0.0.1' );
		} );

		it( 'defaults to 127.0.0.1 when MCP_BIND is whitespace', () => {
			vi.stubEnv( 'MCP_BIND', '   ' );
			expect( resolveHttpConfig().host ).toBe( '127.0.0.1' );
		} );

		it( 'trims and returns MCP_BIND when set', () => {
			vi.stubEnv( 'MCP_BIND', '  0.0.0.0  ' );
			expect( resolveHttpConfig().host ).toBe( '0.0.0.0' );
		} );

		it.each( [ '0.0.0.0', 'localhost', '::1', '::', 'wiki.example.org' ] )(
			'passes %s through unchanged',
			( value ) => {
				vi.stubEnv( 'MCP_BIND', value );
				expect( resolveHttpConfig().host ).toBe( value );
			}
		);
	} );

	describe( 'port', () => {
		it( 'defaults to 3000 when PORT is unset', () => {
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );

		it( 'defaults to 3000 when PORT is empty', () => {
			vi.stubEnv( 'PORT', '' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );

		it( 'parses a valid integer', () => {
			vi.stubEnv( 'PORT', '8080' );
			expect( resolveHttpConfig().port ).toBe( 8080 );
		} );

		it( 'defaults to 3000 when PORT is non-numeric', () => {
			vi.stubEnv( 'PORT', 'nope' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );

		it( 'defaults to 3000 when PORT is zero or negative', () => {
			vi.stubEnv( 'PORT', '0' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
			vi.stubEnv( 'PORT', '-5' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );

		it( 'accepts PORT at the 65535 upper boundary', () => {
			vi.stubEnv( 'PORT', '65535' );
			expect( resolveHttpConfig().port ).toBe( 65535 );
		} );

		it( 'defaults to 3000 when PORT is 65536 (one above the upper boundary)', () => {
			vi.stubEnv( 'PORT', '65536' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );

		it( 'defaults to 3000 when PORT exceeds 65535', () => {
			vi.stubEnv( 'PORT', '99999' );
			expect( resolveHttpConfig().port ).toBe( 3000 );
		} );
	} );

	describe( 'allowedHosts', () => {
		it( 'is undefined when MCP_ALLOWED_HOSTS is unset', () => {
			expect( resolveHttpConfig().allowedHosts ).toBeUndefined();
		} );

		it( 'is undefined when MCP_ALLOWED_HOSTS is empty', () => {
			vi.stubEnv( 'MCP_ALLOWED_HOSTS', '' );
			expect( resolveHttpConfig().allowedHosts ).toBeUndefined();
		} );

		it( 'parses a single entry', () => {
			vi.stubEnv( 'MCP_ALLOWED_HOSTS', 'wiki.example.org' );
			expect( resolveHttpConfig().allowedHosts ).toEqual( [ 'wiki.example.org' ] );
		} );

		it( 'parses multiple comma-separated entries', () => {
			vi.stubEnv( 'MCP_ALLOWED_HOSTS', 'a.example,b.example' );
			expect( resolveHttpConfig().allowedHosts ).toEqual( [ 'a.example', 'b.example' ] );
		} );

		it( 'trims whitespace and drops empty entries', () => {
			vi.stubEnv( 'MCP_ALLOWED_HOSTS', ' a.example , ,  b.example ' );
			expect( resolveHttpConfig().allowedHosts ).toEqual( [ 'a.example', 'b.example' ] );
		} );

		it( 'is undefined when input is only separators', () => {
			vi.stubEnv( 'MCP_ALLOWED_HOSTS', ',,,' );
			expect( resolveHttpConfig().allowedHosts ).toBeUndefined();
		} );
	} );
} );
