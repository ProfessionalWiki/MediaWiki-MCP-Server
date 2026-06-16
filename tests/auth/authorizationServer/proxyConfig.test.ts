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
});
