import { describe, it, expect } from 'vitest';
import { buildAsMetadata } from '../../../src/auth/authorizationServer/asMetadata.js';
import type { ProxyConfig } from '../../../src/auth/authorizationServer/proxyConfig.js';

const pc = { issuer: 'https://wiki.example/mcp' } as ProxyConfig;

describe('buildAsMetadata', () => {
	it('advertises self endpoints with S256 and none auth', () => {
		const m = buildAsMetadata(pc);
		expect(m.issuer).toBe('https://wiki.example/mcp');
		expect(m.authorization_endpoint).toBe('https://wiki.example/mcp/authorize');
		expect(m.token_endpoint).toBe('https://wiki.example/mcp/token');
		expect(m.registration_endpoint).toBe('https://wiki.example/mcp/register');
		expect(m.code_challenge_methods_supported).toEqual(['S256']);
		expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
		expect(m.authorization_response_iss_parameter_supported).toBe(true);
	});

	it('advertises authorization_code and refresh_token grants and code response type', () => {
		const m = buildAsMetadata(pc);
		expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
		expect(m.response_types_supported).toEqual(['code']);
	});

	it('omits scopes_supported when not provided', () => {
		const m = buildAsMetadata(pc);
		expect(m.scopes_supported).toBeUndefined();
	});

	it('includes scopes_supported when provided', () => {
		const m = buildAsMetadata(pc, ['read', 'write']);
		expect(m.scopes_supported).toEqual(['read', 'write']);
	});

	it('advertises CIMD support and keeps none-only token auth', () => {
		const doc = buildAsMetadata(pc);
		expect(doc.client_id_metadata_document_supported).toBe(true);
		expect(doc.token_endpoint_auth_methods_supported).toEqual(['none']);
	});
});
