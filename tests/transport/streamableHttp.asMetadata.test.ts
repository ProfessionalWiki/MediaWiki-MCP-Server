import { describe, it, expect } from 'vitest';

import request from 'supertest';
import { buildApp } from '../../src/transport/streamableHttp.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { fakeProxyConfig } from '../helpers/fakeProxyConfig.ts';
import { fakeHostedProxy } from '../helpers/fakeHostedProxy.ts';
import { fakeAuthPolicy } from '../helpers/fakeAuthPolicy.ts';
import { fakeAppDeps } from '../helpers/fakeAppDeps.ts';

// A proxy whose own issuer (mcp.example) differs from the upstream wiki it
// fronts, so an endpoint accidentally rooted at the wiki rather than at the
// issuer shows up in the assertions below.
const PROXY = fakeProxyConfig({
	issuer: 'https://mcp.example/mcp',
	tokenExchangeBase: 'https://wiki.svc',
	callbackUrl: 'https://mcp.example/mcp/oauth/callback',
	upstreamClientId: 'client-id',
});

describe('GET /.well-known/oauth-authorization-server', () => {
	it('returns 200 with self-naming AS metadata at both paths', async () => {
		const { app } = buildApp(
			fakeAppDeps({
				auth: fakeAuthPolicy({
					transport: 'http',
					hostedProxy: fakeHostedProxy(PROXY, new InMemoryProxyStore()),
				}),
			}),
		);

		for (const path of [
			'/.well-known/oauth-authorization-server',
			'/.well-known/oauth-authorization-server/mcp',
		]) {
			const res = await request(app).get(path);
			expect(res.status).toBe(200);
			expect(res.body.issuer).toBe('https://mcp.example/mcp');
			expect(res.body.authorization_endpoint).toBe('https://mcp.example/mcp/authorize');
			expect(res.body.token_endpoint).toBe('https://mcp.example/mcp/token');
			expect(res.body.registration_endpoint).toBe('https://mcp.example/mcp/register');
			expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
			expect(res.body.token_endpoint_auth_methods_supported).toEqual(['none']);
			expect(res.body.authorization_response_iss_parameter_supported).toBe(true);
		}
	});
});
