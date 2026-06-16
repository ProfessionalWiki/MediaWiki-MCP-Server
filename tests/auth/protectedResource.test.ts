// tests/auth/protectedResource.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildProtectedResource,
	type ProtectedResourceInput,
} from '../../src/auth/protectedResource.js';
import type { AsMetadata } from '../../src/auth/metadata.js';

const baseMetadata: AsMetadata = {
	issuer: 'https://wiki.example.org',
	authorization_endpoint: 'https://wiki.example.org/w/rest.php/oauth2/authorize',
	token_endpoint: 'https://wiki.example.org/w/rest.php/oauth2/access_token',
	source: 'well-known',
	synthesized: false,
};

const metadataWithScopes: AsMetadata = {
	...baseMetadata,
	scopes_supported: ['basic', 'editpage'],
};

function makeInput(overrides: Partial<ProtectedResourceInput> = {}): ProtectedResourceInput {
	return {
		wikis: { mywiki: { oauth2ClientId: 'client-abc' } },
		metadatas: [baseMetadata],
		requestHost: 'mcp.example.org',
		requestProto: 'https',
		...overrides,
	};
}

describe('buildProtectedResource', () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env.MCP_PUBLIC_URL;
		delete process.env.MCP_PUBLIC_URL;
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env.MCP_PUBLIC_URL;
		} else {
			process.env.MCP_PUBLIC_URL = savedEnv;
		}
	});

	it('returns undefined when no wiki has oauth2ClientId', () => {
		const result = buildProtectedResource(
			makeInput({ wikis: { mywiki: { oauth2ClientId: undefined } } }),
		);
		expect(result).toBeUndefined();
	});

	it('returns undefined when oauth2ClientId is empty string', () => {
		const result = buildProtectedResource(makeInput({ wikis: { mywiki: { oauth2ClientId: '' } } }));
		expect(result).toBeUndefined();
	});

	it('returns undefined when oauth2ClientId is null', () => {
		const result = buildProtectedResource(
			makeInput({ wikis: { mywiki: { oauth2ClientId: null } } }),
		);
		expect(result).toBeUndefined();
	});

	it('returns a doc when at least one wiki has a non-empty oauth2ClientId', () => {
		const result = buildProtectedResource(makeInput());
		expect(result).toBeDefined();
	});

	it('sets resource (slash-free identifier) from request host and proto', () => {
		const result = buildProtectedResource(makeInput());
		expect(result?.resource).toBe('https://mcp.example.org');
	});

	it('resource is the slash-free canonical URL (matches the AS issuer)', () => {
		process.env.MCP_PUBLIC_URL = 'https://mcp.example.org/no-trailing';
		const result = buildProtectedResource(makeInput());
		expect(result?.resource).toBe('https://mcp.example.org/no-trailing');
	});

	it('strips a trailing slash from MCP_PUBLIC_URL for the resource identifier', () => {
		process.env.MCP_PUBLIC_URL = 'https://mcp.example.org/with-slash/';
		const result = buildProtectedResource(makeInput());
		expect(result?.resource).toBe('https://mcp.example.org/with-slash');
	});

	it('MCP_PUBLIC_URL takes precedence over request-derived URL', () => {
		process.env.MCP_PUBLIC_URL = 'https://public.example.com/';
		const result = buildProtectedResource(
			makeInput({ requestHost: 'internal.example.org', requestProto: 'http' }),
		);
		expect(result?.resource).toBe('https://public.example.com');
	});

	it('falls back to https://localhost when requestHost is undefined', () => {
		const result = buildProtectedResource(
			makeInput({ requestHost: undefined, requestProto: undefined }),
		);
		expect(result?.resource).toBe('https://localhost');
	});

	it('lists the AS issuer in authorization_servers', () => {
		const result = buildProtectedResource(makeInput());
		expect(result?.authorization_servers).toEqual(['https://wiki.example.org']);
	});

	it('always includes bearer_methods_supported: ["header"]', () => {
		const result = buildProtectedResource(makeInput());
		expect(result?.bearer_methods_supported).toEqual(['header']);
	});

	it('omits scopes_supported when AS metadata has none', () => {
		const result = buildProtectedResource(makeInput());
		expect(result).not.toHaveProperty('scopes_supported');
	});

	it('includes scopes_supported when AS metadata declares it', () => {
		const result = buildProtectedResource(makeInput({ metadatas: [metadataWithScopes] }));
		expect(result?.scopes_supported).toEqual(['basic', 'editpage']);
	});

	it('includes resource_documentation pointing at configuration.md OAuth section', () => {
		const result = buildProtectedResource(makeInput());
		expect(result?.resource_documentation).toBe(
			'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/blob/master/docs/configuration.md#oauth',
		);
	});

	it('returns a doc when any one of multiple wikis opts in', () => {
		const result = buildProtectedResource(
			makeInput({
				wikis: {
					wiki1: { oauth2ClientId: undefined },
					wiki2: { oauth2ClientId: 'client-xyz' },
				},
			}),
		);
		expect(result).toBeDefined();
	});

	it('lists every distinct issuer across multiple authorization servers', () => {
		const doc = buildProtectedResource({
			wikis: { a: { oauth2ClientId: 'ca' }, b: { oauth2ClientId: 'cb' } },
			metadatas: [
				{
					issuer: 'https://a.example',
					authorization_endpoint: 'x',
					token_endpoint: 'y',
					source: 'well-known',
					synthesized: false,
					scopes_supported: ['read'],
				},
				{
					issuer: 'https://b.example',
					authorization_endpoint: 'x',
					token_endpoint: 'y',
					source: 'well-known',
					synthesized: false,
					scopes_supported: ['write'],
				},
				{
					issuer: 'https://a.example',
					authorization_endpoint: 'x',
					token_endpoint: 'y',
					source: 'well-known',
					synthesized: false,
				},
			],
			requestHost: 'mcp.example',
			requestProto: 'https',
		});
		expect(doc?.authorization_servers).toEqual(['https://a.example', 'https://b.example']);
		expect(doc?.scopes_supported?.sort()).toEqual(['read', 'write']);
	});

	it('returns undefined when no metadata resolved', () => {
		expect(
			buildProtectedResource({
				wikis: { a: { oauth2ClientId: 'ca' } },
				metadatas: [],
				requestHost: 'mcp.example',
				requestProto: 'https',
			}),
		).toBeUndefined();
	});
});
