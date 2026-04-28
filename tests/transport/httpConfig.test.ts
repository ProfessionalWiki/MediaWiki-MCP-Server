import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveHttpConfig } from '../../src/transport/httpConfig.js';

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

	describe( 'allowedOrigins', () => {
		it( 'defaults to the localhost trio on the bound port for a 127.0.0.1 bind', () => {
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [
				'http://localhost:3000',
				'http://127.0.0.1:3000',
				'http://[::1]:3000'
			] );
		} );

		it( 'tracks the bound PORT in the localhost default list', () => {
			vi.stubEnv( 'PORT', '8080' );
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [
				'http://localhost:8080',
				'http://127.0.0.1:8080',
				'http://[::1]:8080'
			] );
		} );

		it.each( [ 'localhost', '::1' ] )(
			'defaults to the localhost trio when MCP_BIND is %s',
			( value ) => {
				vi.stubEnv( 'MCP_BIND', value );
				expect( resolveHttpConfig().allowedOrigins ).toEqual( [
					'http://localhost:3000',
					'http://127.0.0.1:3000',
					'http://[::1]:3000'
				] );
			}
		);

		it( 'is undefined when bound to 0.0.0.0 without MCP_ALLOWED_ORIGINS', () => {
			vi.stubEnv( 'MCP_BIND', '0.0.0.0' );
			expect( resolveHttpConfig().allowedOrigins ).toBeUndefined();
		} );

		it( 'is undefined when bound to an external host without MCP_ALLOWED_ORIGINS', () => {
			vi.stubEnv( 'MCP_BIND', 'wiki.example.org' );
			expect( resolveHttpConfig().allowedOrigins ).toBeUndefined();
		} );

		it( 'MCP_ALLOWED_ORIGINS overrides the localhost default', () => {
			vi.stubEnv( 'MCP_ALLOWED_ORIGINS', 'https://app.example.org' );
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [ 'https://app.example.org' ] );
		} );

		it( 'parses multiple comma-separated MCP_ALLOWED_ORIGINS entries', () => {
			vi.stubEnv( 'MCP_BIND', '0.0.0.0' );
			vi.stubEnv( 'MCP_ALLOWED_ORIGINS', 'https://a.example,https://b.example' );
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [
				'https://a.example',
				'https://b.example'
			] );
		} );

		it( 'trims whitespace and drops empty entries', () => {
			vi.stubEnv( 'MCP_BIND', '0.0.0.0' );
			vi.stubEnv( 'MCP_ALLOWED_ORIGINS', ' https://a.example , ,  https://b.example ' );
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [
				'https://a.example',
				'https://b.example'
			] );
		} );

		it( 'falls back to the localhost default when MCP_ALLOWED_ORIGINS is empty', () => {
			vi.stubEnv( 'MCP_ALLOWED_ORIGINS', '' );
			expect( resolveHttpConfig().allowedOrigins ).toEqual( [
				'http://localhost:3000',
				'http://127.0.0.1:3000',
				'http://[::1]:3000'
			] );
		} );

		it( 'is undefined when MCP_ALLOWED_ORIGINS is only separators and bound to 0.0.0.0', () => {
			vi.stubEnv( 'MCP_BIND', '0.0.0.0' );
			vi.stubEnv( 'MCP_ALLOWED_ORIGINS', ',,,' );
			expect( resolveHttpConfig().allowedOrigins ).toBeUndefined();
		} );
	} );
} );
