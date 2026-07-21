import { describe, it, expect, afterEach, vi } from 'vitest';

// Importing streamableHttp.ts runs its module top-level boot (config load,
// startup guard, app.listen). Mock the config + mwn provider so the boot is
// harmless under test, matching streamableHttp.oauth.test.ts.
vi.mock('../../src/config/loadConfig.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/config/loadConfig.js')>();
	return {
		...actual,
		loadConfigFromFile: () => ({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test',
					server: 'https://test.example',
					articlepath: '/wiki',
					scriptpath: '/w',
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		}),
	};
});

vi.mock('../../src/wikis/mwnProvider.js', () => ({
	MwnProviderImpl: class {
		get = () => Promise.reject(new Error('mwn not available in tests'));
		invalidate = () => {};
	},
}));

import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import {
	createOAuthProtectedResourceHandler,
	type ProxyConfigGetter,
} from '../../src/transport/streamableHttp.js';
import { buildAsMetadata } from '../../src/auth/authorizationServer/asMetadata.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';

function fakeRegistry(wikis: Record<string, Partial<WikiConfig>>): WikiRegistry {
	return {
		getAll: () => wikis as Record<string, WikiConfig>,
		get: (k: string) => wikis[k] as WikiConfig | undefined,
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => false,
	} as unknown as WikiRegistry;
}

const PROXY: ProxyConfig = {
	issuer: 'https://mcp.example/mcp',
	authorizeBase: 'https://wiki.example',
	tokenExchangeBase: 'https://wiki.svc',
	scriptpath: '/w',
	callbackUrl: 'https://mcp.example/mcp/oauth/callback',
	upstreamClientId: 'client-id',
	signingKey: 'k'.repeat(32),
	consentTtlMs: 1000,
	tokenTtlMs: 1000,
	redirectAllowlist: [],
};

// Mirrors the production AS-metadata route handler in streamableHttp.ts so the
// 200/404 gating can be exercised without booting the side-effecting module.
function asMetadataHandler(getProxyConfig: ProxyConfigGetter): RequestHandler {
	return (_req, res) => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
			return;
		}
		res.json(buildAsMetadata(pc));
	};
}

function buildApp(registry: WikiRegistry, getProxyConfig: ProxyConfigGetter): Express {
	const app = express();
	app.use(express.json());
	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({ wikiRegistry: registry, getProxyConfig }),
	);
	const handler = asMetadataHandler(getProxyConfig);
	app.get('/.well-known/oauth-authorization-server', handler);
	app.get('/.well-known/oauth-authorization-server/mcp', handler);
	return app;
}

describe('GET /.well-known/oauth-authorization-server (proxy enabled)', () => {
	it('returns 200 with self-naming AS metadata at both paths', async () => {
		const app = buildApp(fakeRegistry({}), () => PROXY);

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

	it('returns 404 at both paths when the proxy is not enabled', async () => {
		const app = buildApp(fakeRegistry({}), () => null);

		for (const path of [
			'/.well-known/oauth-authorization-server',
			'/.well-known/oauth-authorization-server/mcp',
		]) {
			const res = await request(app).get(path);
			expect(res.status).toBe(404);
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
		const app = buildApp(fakeRegistry({ mywiki: wikiCfg }), () => PROXY);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		expect(res.body.authorization_servers).toEqual(['https://mcp.example/mcp']);
	});

	it('falls back to the upstream wiki issuer when the proxy is disabled', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const app = buildApp(fakeRegistry({ mywiki: wikiCfg }), () => null);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		expect(res.body.authorization_servers).toEqual([fakeAs.url]);
	});
});
