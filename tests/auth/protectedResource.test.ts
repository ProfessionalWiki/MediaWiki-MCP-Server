// tests/auth/protectedResource.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildProtectedResource,
	type ProtectedResourceInput,
} from '../../src/auth/protectedResource.ts';
import type { UpstreamAsMetadata } from '../../src/auth/metadata.ts';

const baseMetadata: UpstreamAsMetadata = {
	issuer: 'https://wiki.example.org',
	authorization_endpoint: 'https://wiki.example.org/w/rest.php/oauth2/authorize',
	token_endpoint: 'https://wiki.example.org/w/rest.php/oauth2/access_token',
	source: 'well-known',
	synthesized: false,
};

const metadataWithScopes: UpstreamAsMetadata = {
	...baseMetadata,
	scopes_supported: ['basic', 'editpage'],
};

function makeInput(overrides: Partial<ProtectedResourceInput> = {}): ProtectedResourceInput {
	return {
		wikis: { mywiki: { oauth2ClientId: 'client-abc' } },
		metadatas: [baseMetadata],
		authorizationServers: ['https://mcp.example.org/mcp'],
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

	it('canonicalizes MCP_PUBLIC_URL host case so resource matches the issuer (#7)', () => {
		process.env.MCP_PUBLIC_URL = 'https://MCP.Example.ORG/mcp';
		const result = buildProtectedResource(makeInput());
		// resolveProxyConfig lowercases the issuer host via new URL(); the resource
		// must canonicalize identically or the SDK's resource==issuer check fails.
		expect(result?.resource).toBe('https://mcp.example.org/mcp');
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

	it('lists the given authorization server, not the wiki that metadata came from', () => {
		const result = buildProtectedResource(makeInput());
		expect(result?.authorization_servers).toEqual(['https://mcp.example.org/mcp']);
		// baseMetadata's issuer is the wiki's own; it supplies scopes, never issuers.
		expect(result?.authorization_servers).not.toContain('https://wiki.example.org');
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

	it('names only the given authorization server, whatever the wikis use', () => {
		const doc = buildProtectedResource(
			makeInput({
				wikis: { a: { oauth2ClientId: 'ca' }, b: { oauth2ClientId: 'cb' } },
				metadatas: [
					{ ...baseMetadata, issuer: 'https://a.example' },
					{ ...baseMetadata, issuer: 'https://b.example' },
				],
			}),
		);

		// The wikis' own issuers are never advertised: a client minting a token there
		// and presenting it here is the shape the passthrough prohibition forbids.
		expect(doc?.authorization_servers).toEqual(['https://mcp.example.org/mcp']);
		expect(doc?.authorization_servers).not.toContain('https://a.example');
		expect(doc?.authorization_servers).not.toContain('https://b.example');
	});

	it('returns undefined when no metadata resolved', () => {
		expect(
			buildProtectedResource({
				wikis: { a: { oauth2ClientId: 'ca' } },
				metadatas: [],
				authorizationServers: ['https://mcp.example.org/mcp'],
				requestHost: 'mcp.example',
				requestProto: 'https',
			}),
		).toBeUndefined();
	});
});
