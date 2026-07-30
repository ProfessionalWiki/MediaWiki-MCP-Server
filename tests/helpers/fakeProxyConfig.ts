import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';

// One source for the proxy-config literal the auth suites need. Built as a
// complete ProxyConfig so a field added to the interface breaks here once,
// rather than in each suite that happened to spell the literal out.
//
// Carries an upstream client secret because resolveProxyConfig refuses to start
// without one, so a resolved config always has it. Pass
// `{ upstreamClientSecret: undefined }` to reach the public-client path.
export function fakeProxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
	return {
		issuer: 'https://wiki.example/mcp',
		authorizeBase: 'https://wiki.example',
		tokenExchangeBase: 'https://wiki.example',
		scriptpath: '/w',
		callbackUrl: 'https://wiki.example/mcp/oauth/callback',
		upstreamClientId: 'UP',
		upstreamClientSecret: 'UP-SECRET',
		signingKey: 'x'.repeat(32),
		consentTtlMs: 1000,
		tokenTtlMs: 1000,
		redirectAllowlist: [],
		cimdAllowedHosts: [],
		...overrides,
	};
}
