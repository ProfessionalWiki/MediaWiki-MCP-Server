import { describe, it, expect, afterEach, vi } from 'vitest';

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

import express, { type Express } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	createOAuthProtectedResourceHandler,
	createMcpPostHandler,
	type SessionRegistry,
} from '../../src/transport/streamableHttp.js';
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

function buildWellKnownApp(registry: WikiRegistry): Express {
	const app = express();
	app.use(express.json());
	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({ wikiRegistry: registry }),
	);
	return app;
}

function stubCreateServer(): McpServer {
	return new McpServer({ name: 'oauth-test-server', version: '0.0.0' }, { capabilities: {} });
}

function buildMcpApp(registry: WikiRegistry): Express {
	const app = express();
	app.use(express.json());
	const sessions: SessionRegistry = {};
	app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, { wikiRegistry: registry }));
	return app;
}

describe('GET /.well-known/oauth-protected-resource', () => {
	let fakeAs: FakeAsHandle | undefined;

	afterEach(async () => {
		_resetMetadataCacheForTesting();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	it('returns 200 with authorization_servers when a wiki has oauth2ClientId', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const registry = fakeRegistry({ mywiki: wikiCfg });
		const app = buildWellKnownApp(registry);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		expect(res.body.authorization_servers).toBeDefined();
		expect(Array.isArray(res.body.authorization_servers)).toBe(true);
		expect(res.body.authorization_servers[0]).toBe(fakeAs.url);
		expect(res.body.bearer_methods_supported).toEqual(['header']);
	});

	it('returns 404 when no wiki has oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'PlainWiki',
			server: 'https://plain.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const registry = fakeRegistry({ plain: wikiCfg });
		const app = buildWellKnownApp(registry);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(404);
	});

	it('returns 404 when oauth2ClientId is an empty string', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'EmptyOAuth',
			server: 'https://empty.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: '',
		};
		const registry = fakeRegistry({ empty: wikiCfg });
		const app = buildWellKnownApp(registry);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(404);
	});

	it('uses x-forwarded-proto for the resource URL', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const registry = fakeRegistry({ mywiki: wikiCfg });
		const app = buildWellKnownApp(registry);

		// MCP_PUBLIC_URL not set; resource is derived from host header and proto
		const res = await request(app)
			.get('/.well-known/oauth-protected-resource')
			.set('Host', 'mcp.example.org')
			.set('x-forwarded-proto', 'https');
		expect(res.status).toBe(200);
		// resource should use https and be the slash-free canonical identifier
		expect(res.body.resource).toBe('https://mcp.example.org');
	});

	it('lists every OAuth wiki authorization server when two wikis use different servers', async () => {
		fakeAs = await startFakeAs();
		const fakeAs2 = await startFakeAs();
		try {
			const wikiCfgA: Partial<WikiConfig> = {
				sitename: 'WikiA',
				server: fakeAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-a',
			};
			const wikiCfgB: Partial<WikiConfig> = {
				sitename: 'WikiB',
				server: fakeAs2.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-b',
			};
			const registry = fakeRegistry({ wikiA: wikiCfgA, wikiB: wikiCfgB });
			const app = buildWellKnownApp(registry);

			const res = await request(app).get('/.well-known/oauth-protected-resource');
			expect(res.status).toBe(200);
			expect(res.body.authorization_servers).toContain(fakeAs.url);
			expect(res.body.authorization_servers).toContain(fakeAs2.url);
			expect(res.body.authorization_servers).toHaveLength(2);
		} finally {
			await fakeAs2.close();
		}
	});

	it('still includes a reachable wiki AS when another wiki metadata fetch rejects', async () => {
		fakeAs = await startFakeAs();
		// A second AS that explicitly advertises a non-S256 PKCE method makes
		// fetchMetadata reject with MetadataError; Promise.allSettled keeps it
		// out of the document while the reachable wiki's AS survives.
		const badAs = await startFakeAs({
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		try {
			const reachable: Partial<WikiConfig> = {
				sitename: 'Reachable',
				server: fakeAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-ok',
			};
			const rejecting: Partial<WikiConfig> = {
				sitename: 'Rejecting',
				server: badAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-bad',
			};
			const registry = fakeRegistry({ reachable: reachable, rejecting: rejecting });
			const app = buildWellKnownApp(registry);

			const res = await request(app).get('/.well-known/oauth-protected-resource');
			expect(res.status).toBe(200);
			expect(res.body.authorization_servers).toContain(fakeAs.url);
			expect(res.body.authorization_servers).not.toContain(badAs.url);
		} finally {
			await badAs.close();
		}
	});

	it('returns 503 when every OAuth wiki metadata fetch rejects', async () => {
		const badAs = await startFakeAs({
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		try {
			const rejecting: Partial<WikiConfig> = {
				sitename: 'Rejecting',
				server: badAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-bad',
			};
			const registry = fakeRegistry({ rejecting: rejecting });
			const app = buildWellKnownApp(registry);

			const res = await request(app).get('/.well-known/oauth-protected-resource');
			expect(res.status).toBe(503);
			expect(res.body.error).toBe('discovery_failed');
		} finally {
			await badAs.close();
		}
	});
});

describe('POST /mcp 401 short-circuit when every wiki requires auth', () => {
	afterEach(() => {
		delete process.env.MCP_ALLOW_STATIC_FALLBACK;
		vi.unstubAllEnvs();
	});

	it('returns 401 with WWW-Authenticate when no bearer and wiki has oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.error?.code).toBe(-32001);
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/Bearer realm="MediaWiki MCP Server"/);
		expect(wwwAuth).toMatch(/resource_metadata="/);
		expect(wwwAuth).toMatch(/\/.well-known\/oauth-protected-resource"/);
	});

	it('does NOT return 401 when the wiki has no oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'PlainWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const app = buildMcpApp(fakeRegistry({ plain: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when wikiRegistry is not provided to handler', async () => {
		// If wikiRegistry is omitted entirely, the 401 check is skipped
		const app = express();
		app.use(express.json());
		const sessions: SessionRegistry = {};
		app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, {}));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when bearer is present even with oauth2ClientId set', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer some-valid-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		// With a bearer token present, the 401 short-circuit is skipped;
		// the request proceeds to the MCP transport machinery.
		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when MCP_ALLOW_STATIC_FALLBACK=true and wiki has static creds + oauth2ClientId', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'FallbackWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-456',
			token: 'static-bot-token',
		};
		const app = buildMcpApp(fakeRegistry({ fallback: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when MCP_ALLOW_STATIC_FALLBACK=true and wiki has username+password + oauth2ClientId', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'FallbackWiki2',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-789',
			username: 'bot-user',
			password: 'bot-pass',
		};
		const app = buildMcpApp(fakeRegistry({ fallback2: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('DOES return 401 when oauth2ClientId set and MCP_ALLOW_STATIC_FALLBACK=true but no static creds', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthOnly',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-000',
		};
		const app = buildMcpApp(fakeRegistry({ oauthonly: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
	});

	it('metadata URL in WWW-Authenticate uses x-forwarded-proto when present', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Host', 'mcp.example.org:443')
			.set('x-forwarded-proto', 'https')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('https://mcp.example.org:443/.well-known/oauth-protected-resource');
	});

	it('metadata URL in WWW-Authenticate honours MCP_PUBLIC_URL over request Host', async () => {
		vi.stubEnv('MCP_PUBLIC_URL', 'https://override.example.org/');
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Host', 'internal.example.org')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('https://override.example.org/.well-known/oauth-protected-resource');
		expect(wwwAuth).not.toContain('internal.example.org');
	});

	it('returns 401 when EVERY configured wiki is OAuth-only', async () => {
		const wikiA: Partial<WikiConfig> = {
			sitename: 'OAuthA',
			server: 'https://a.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-a',
		};
		const wikiB: Partial<WikiConfig> = {
			sitename: 'OAuthB',
			server: 'https://b.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-b',
		};
		const app = buildMcpApp(fakeRegistry({ wikiA: wikiA, wikiB: wikiB }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		expect(res.body?.error?.code).toBe(-32001);
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/Bearer realm="MediaWiki MCP Server"/);
	});

	it('does NOT return 401 when one wiki is OAuth-only but another needs no auth', async () => {
		const oauthWiki: Partial<WikiConfig> = {
			sitename: 'OAuthOnly',
			server: 'https://oauth.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-oauth',
		};
		const publicWiki: Partial<WikiConfig> = {
			sitename: 'PublicWiki',
			server: 'https://public.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const app = buildMcpApp(fakeRegistry({ oauth: oauthWiki, public: publicWiki }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});
});
