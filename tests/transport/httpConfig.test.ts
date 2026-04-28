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

	describe( 'maxRequestBody', () => {
		it( 'defaults to 1mb when MCP_MAX_REQUEST_BODY is unset', () => {
			expect( resolveHttpConfig().maxRequestBody ).toBe( '1mb' );
		} );

		it( 'defaults to 1mb when MCP_MAX_REQUEST_BODY is empty', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '' );
			expect( resolveHttpConfig().maxRequestBody ).toBe( '1mb' );
		} );

		it( 'defaults to 1mb when MCP_MAX_REQUEST_BODY is whitespace', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '   ' );
			expect( resolveHttpConfig().maxRequestBody ).toBe( '1mb' );
		} );

		it.each( [ '100b', '512kb', '1mb', '2mb', '1.5mb', '1024' ] )(
			'accepts %s and passes it through',
			( value ) => {
				vi.stubEnv( 'MCP_MAX_REQUEST_BODY', value );
				expect( resolveHttpConfig().maxRequestBody ).toBe( value );
			}
		);

		it( 'trims surrounding whitespace from a valid value', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '  2mb  ' );
			expect( resolveHttpConfig().maxRequestBody ).toBe( '2mb' );
		} );

		it.each( [ 'potato', '1md', '--', '5 mibibytes', '.5mb' ] )(
			'falls back to 1mb when MCP_MAX_REQUEST_BODY=%s is malformed',
			( value ) => {
				vi.stubEnv( 'MCP_MAX_REQUEST_BODY', value );
				expect( resolveHttpConfig().maxRequestBody ).toBe( '1mb' );
			}
		);

		it.each( [ '0', '0mb', '0kb', '0.0mb' ] )(
			'falls back to 1mb when MCP_MAX_REQUEST_BODY=%s would reject all requests',
			( value ) => {
				vi.stubEnv( 'MCP_MAX_REQUEST_BODY', value );
				expect( resolveHttpConfig().maxRequestBody ).toBe( '1mb' );
			}
		);

		it( 'still passes through fractional sub-1mb values like 0.5mb', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '0.5mb' );
			expect( resolveHttpConfig().maxRequestBody ).toBe( '0.5mb' );
		} );
	} );

	describe( 'warnings', () => {
		it( 'is empty by default', () => {
			expect( resolveHttpConfig().warnings ).toEqual( [] );
		} );

		it( 'is empty for valid MCP_MAX_REQUEST_BODY', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '2mb' );
			expect( resolveHttpConfig().warnings ).toEqual( [] );
		} );

		it( 'contains a warning naming the rejected raw value when MCP_MAX_REQUEST_BODY is malformed', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '1md' );
			const { warnings } = resolveHttpConfig();
			expect( warnings ).toHaveLength( 1 );
			expect( warnings[ 0 ] ).toContain( 'MCP_MAX_REQUEST_BODY' );
			expect( warnings[ 0 ] ).toContain( '1md' );
			expect( warnings[ 0 ] ).toContain( '1mb' );
		} );

		it( 'emits a "would reject all requests" warning when MCP_MAX_REQUEST_BODY is zero', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '0' );
			const { warnings } = resolveHttpConfig();
			expect( warnings ).toHaveLength( 1 );
			expect( warnings[ 0 ] ).toContain( 'MCP_MAX_REQUEST_BODY' );
			expect( warnings[ 0 ] ).toContain( 'would reject all requests' );
			expect( warnings[ 0 ] ).toContain( '1mb' );
		} );

		it( 'distinguishes the zero warning from the malformed warning', () => {
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '0mb' );
			const zeroWarnings = resolveHttpConfig().warnings;
			vi.unstubAllEnvs();
			vi.stubEnv( 'MCP_MAX_REQUEST_BODY', '1md' );
			const malformedWarnings = resolveHttpConfig().warnings;
			expect( zeroWarnings[ 0 ] ).not.toBe( malformedWarnings[ 0 ] );
			expect( zeroWarnings[ 0 ] ).toContain( 'would reject' );
			expect( malformedWarnings[ 0 ] ).toContain( 'not a recognised size' );
		} );
	} );
} );
