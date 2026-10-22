import { describe, it, expect, afterEach } from 'vitest';

import express, { type Express } from 'express';
import request from 'supertest';
import { createOAuthProtectedResourceHandler } from '../../src/transport/streamableHttp.ts';
import { mountAuthorizationServer } from '../../src/auth/authorizationServer/router.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import type { HostedProxy } from '../../src/auth/authorizationServer/hostedProxy.ts';
import { fakeProxyConfig } from '../helpers/fakeProxyConfig.ts';
import { fakeHostedProxy } from '../helpers/fakeHostedProxy.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.ts';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';

function fakeRegistry(wikis: Record<string, Partial<WikiConfig>>): WikiRegistry {
	return {
		getAll: () => wikis as Record<string, WikiConfig>,
		get: (k: string) => wikis[k] as WikiConfig | undefined,
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => false,
	} as unknown as WikiRegistry;
}

// A proxy whose own issuer (mcp.example) differs from the upstream wiki it
// fronts, so an endpoint accidentally rooted at the wiki rather than at the
// issuer shows up in the assertions below.
const PROXY = fakeProxyConfig({
	issuer: 'https://mcp.example/mcp',
	tokenExchangeBase: 'https://wiki.svc',
	callbackUrl: 'https://mcp.example/mcp/oauth/callback',
	upstreamClientId: 'client-id',
});

function buildApp(registry: WikiRegistry, proxy: HostedProxy | null): Express {
	const app = express();
	app.use(express.json());
	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({
			wikiRegistry: registry,
			authorizationServer: proxy?.config.issuer ?? null,
		}),
	);
	if (proxy) {
		mountAuthorizationServer(app, proxy);
	}
	return app;
}

describe('GET /.well-known/oauth-authorization-server', () => {
	it('returns 200 with self-naming AS metadata at both paths', async () => {
		const app = buildApp(fakeRegistry({}), fakeHostedProxy(PROXY, new InMemoryProxyStore()));

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

describe('protected-resource authorization_servers self-advertise', () => {
	let fakeAs: FakeAsHandle | undefined;

	afterEach(async () => {
		_resetMetadataCacheForTesting();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	it('advertises the proxy issuer (self) when the proxy is enabled', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const app = buildApp(
			fakeRegistry({ mywiki: wikiCfg }),
			fakeHostedProxy(PROXY, new InMemoryProxyStore()),
		);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		expect(res.body.authorization_servers).toEqual(['https://mcp.example/mcp']);
	});

	it('advertises nothing when the proxy is disabled', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const app = buildApp(fakeRegistry({ mywiki: wikiCfg }), null);

		const res = await request(app).get('/.well-known/oauth-protected-resource');

		// Only the hosted proxy makes this server an authorization server. Naming the
		// wiki's own issuer here is what steered clients into minting tokens at the
		// wiki and presenting them to us, which is the shape the spec forbids.
		expect(res.status).toBe(404);
		// Answered before any upstream discovery, so an unauthenticated request no
		// longer costs one outbound metadata fetch per OAuth wiki.
		expect(fakeAs.metadataRequests.count).toBe(0);
	});
});
