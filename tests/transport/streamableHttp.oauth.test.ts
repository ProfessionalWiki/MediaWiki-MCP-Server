import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../src/config/loadConfig.js', () => ({
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
}));

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
import type { WikiSelection } from '../../src/wikis/wikiSelection.js';
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

function fakeSelection(key: string, cfg: Partial<WikiConfig>): WikiSelection {
	return {
		getCurrent: () => ({ key, config: cfg as WikiConfig }),
		setCurrent: () => {},
		reset: () => {},
	} as unknown as WikiSelection;
}

function buildWellKnownApp(registry: WikiRegistry, selection: WikiSelection): Express {
	const app = express();
	app.use(express.json());
	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({ wikiRegistry: registry, wikiSelection: selection }),
	);
	return app;
}

function stubCreateServer(): McpServer {
	return new McpServer({ name: 'oauth-test-server', version: '0.0.0' }, { capabilities: {} });
}

function buildMcpApp(selection: WikiSelection): Express {
	const app = express();
	app.use(express.json());
	const sessions: SessionRegistry = {};
	app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, { wikiSelection: selection }));
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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildWellKnownApp(registry, selection);

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
		const selection = fakeSelection('plain', wikiCfg);
		const app = buildWellKnownApp(registry, selection);

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
		const selection = fakeSelection('empty', wikiCfg);
		const app = buildWellKnownApp(registry, selection);

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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildWellKnownApp(registry, selection);

		// MCP_PUBLIC_URL not set; resource is derived from host header and proto
		const res = await request(app)
			.get('/.well-known/oauth-protected-resource')
			.set('Host', 'mcp.example.org')
			.set('x-forwarded-proto', 'https');
		expect(res.status).toBe(200);
		// resource should use https
		expect(res.body.resource).toMatch(/^https:\/\/mcp\.example\.org\//);
	});
});

describe('POST /mcp 401 short-circuit for OAuth-only wikis', () => {
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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('plain', wikiCfg);
		const app = buildMcpApp(selection);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when wikiSelection is not provided to handler', async () => {
		// If wikiSelection is omitted entirely, the 401 check is skipped
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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('fallback', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('fallback2', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('oauthonly', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildMcpApp(selection);

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
		const selection = fakeSelection('mywiki', wikiCfg);
		const app = buildMcpApp(selection);

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
});
