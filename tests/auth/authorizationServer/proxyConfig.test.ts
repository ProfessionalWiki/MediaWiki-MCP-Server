import { describe, it, expect } from 'vitest';
import {
	resolveProxyConfig,
	ProxyConfigError,
} from '../../../src/auth/authorizationServer/proxyConfig.js';

const wiki = {
	server: 'http://mediawiki.svc:80',
	scriptpath: '/w',
	oauth2ClientId: 'abc123',
	publicServer: 'https://wiki.example',
};
const env = {
	MCP_TRANSPORT: 'http',
	MCP_PUBLIC_URL: 'https://wiki.example/mcp',
	MCP_OAUTH_JWT_SIGNING_KEY: 'k'.repeat(32),
};

describe('resolveProxyConfig', () => {
	it('returns null when oauth2ClientId is absent', () => {
		expect(resolveProxyConfig('w', { ...wiki, oauth2ClientId: null }, env)).toBeNull();
	});
	it('returns null on stdio transport', () => {
		expect(resolveProxyConfig('w', wiki, { ...env, MCP_TRANSPORT: 'stdio' })).toBeNull();
	});
	it('derives the three bases', () => {
		const c = resolveProxyConfig('w', wiki, env)!;
		expect(c.issuer).toBe('https://wiki.example/mcp');
		expect(c.callbackUrl).toBe('https://wiki.example/mcp/oauth/callback');
		expect(c.authorizeBase).toBe('https://wiki.example');
		expect(c.tokenExchangeBase).toBe('http://mediawiki.svc:80');
	});
	it('falls back to server when publicServer unset', () => {
		const c = resolveProxyConfig('w', { ...wiki, publicServer: undefined }, env)!;
		expect(c.authorizeBase).toBe('http://mediawiki.svc:80');
	});
	it('throws when enabled but signing key too short', () => {
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_JWT_SIGNING_KEY: 'short' }),
		).toThrow(ProxyConfigError);
	});
	it('throws when MCP_PUBLIC_URL malformed', () => {
		expect(() => resolveProxyConfig('w', wiki, { ...env, MCP_PUBLIC_URL: 'not a url' })).toThrow(
			ProxyConfigError,
		);
	});
	it('throws when MCP_PUBLIC_URL is http on a non-local host', () => {
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_PUBLIC_URL: 'http://wiki.example/mcp' }),
		).toThrow(ProxyConfigError);
	});
	it('allows http for localhost (development)', () => {
		const c = resolveProxyConfig('w', wiki, {
			...env,
			MCP_PUBLIC_URL: 'http://localhost:8080/mcp',
		})!;
		expect(c.issuer).toBe('http://localhost:8080/mcp');
	});
	it('allows http for a *.localhost development host', () => {
		const c = resolveProxyConfig('w', wiki, {
			...env,
			MCP_PUBLIC_URL: 'http://dockerwiki.localhost:8080/mcp',
		})!;
		expect(c.issuer).toBe('http://dockerwiki.localhost:8080/mcp');
	});
	it('throws when token TTL exceeds the 30-day refresh window', () => {
		expect(() => resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_TOKEN_TTL: '40d' })).toThrow(
			ProxyConfigError,
		);
	});
	it('parses a minutes duration', () => {
		const c = resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_TOKEN_TTL: '55m' })!;
		expect(c.tokenTtlMs).toBe(3_300_000);
	});
	it('treats a bare number as seconds', () => {
		const c = resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_TOKEN_TTL: '3600' })!;
		expect(c.tokenTtlMs).toBe(3_600_000);
	});
	it('throws on a non-positive token TTL', () => {
		expect(() => resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_TOKEN_TTL: '0' })).toThrow(
			ProxyConfigError,
		);
	});
	it('throws on an unparseable token TTL', () => {
		expect(() => resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_TOKEN_TTL: '1.5h' })).toThrow(
			ProxyConfigError,
		);
	});
	it('uses documented defaults when TTL env vars are absent', () => {
		const c = resolveProxyConfig('w', wiki, env)!;
		expect(c.tokenTtlMs).toBe(55 * 60 * 1000);
		expect(c.consentTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
	});
});

describe('redirect allowlist plumbing', () => {
	it('defaults to an empty list', () => {
		expect(resolveProxyConfig('w', wiki, env)?.redirectAllowlist).toEqual([]);
	});

	it('parses entries from MCP_OAUTH_ALLOWED_REDIRECTS', () => {
		const pc = resolveProxyConfig('w', wiki, {
			...env,
			MCP_OAUTH_ALLOWED_REDIRECTS: 'https://vscode.dev/redirect',
		});
		expect(pc?.redirectAllowlist).toEqual([{ kind: 'exact', uri: 'https://vscode.dev/redirect' }]);
	});

	it('rejects a bare star', () => {
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_ALLOWED_REDIRECTS: '*' }),
		).toThrow(ProxyConfigError);
	});

	it('wraps parse failures in ProxyConfigError naming the env var', () => {
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_ALLOWED_REDIRECTS: 'vscode.dev' }),
		).toThrow(ProxyConfigError);
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_ALLOWED_REDIRECTS: 'vscode.dev' }),
		).toThrow(/MCP_OAUTH_ALLOWED_REDIRECTS/);
	});
});

describe('CIMD host allowlist plumbing', () => {
	it('parses entries from MCP_OAUTH_CIMD_ALLOWED_HOSTS', () => {
		const pc = resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_CIMD_ALLOWED_HOSTS: 'my.wiki' });
		expect(pc?.cimdAllowedHosts).toEqual(['my.wiki']);
	});

	it('wraps parse failures in ProxyConfigError naming the env var', () => {
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_CIMD_ALLOWED_HOSTS: 'bad host' }),
		).toThrow(ProxyConfigError);
		expect(() =>
			resolveProxyConfig('w', wiki, { ...env, MCP_OAUTH_CIMD_ALLOWED_HOSTS: 'bad host' }),
		).toThrow(/MCP_OAUTH_CIMD_ALLOWED_HOSTS/);
	});
});
