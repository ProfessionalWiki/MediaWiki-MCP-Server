import { describe, it, expect, vi } from 'vitest';

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

import express, { type Express } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	resolveUpstreamBearer,
	createMcpPostHandler,
	type ProxyConfigGetter,
	type SessionRegistry,
} from '../../src/transport/streamableHttp.js';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.js';
import { mintAccessToken } from '../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import { getRuntimeToken } from '../../src/transport/requestContext.js';

const pc = {
	issuer: 'https://wiki.example/mcp',
	signingKey: 'k'.repeat(32),
	tokenExchangeBase: 'http://mediawiki.svc:80',
	scriptpath: '/w',
	upstreamClientId: 'UP',
} as unknown as ProxyConfig;

describe('resolveUpstreamBearer', () => {
	it('returns the upstream access token for a valid JWT', async () => {
		const store = new InMemoryProxyStore();
		const id = store.putUpstreamToken({ accessToken: 'WA', expiresAt: Date.now() + 1e6 });
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		expect(await resolveUpstreamBearer(jwt, pc, store)).toBe('WA');
	});

	it('throws on an invalid JWT', async () => {
		const store = new InMemoryProxyStore();
		await expect(resolveUpstreamBearer('garbage', pc, store)).rejects.toThrow();
	});

	it('throws when the upstream token is missing from the store', async () => {
		const store = new InMemoryProxyStore();
		// Mint a JWT whose jti points at an upstream token that was never stored.
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: 'never-stored',
			ttlMs: 60_000,
			scopes: [],
		});
		await expect(resolveUpstreamBearer(jwt, pc, store)).rejects.toThrow();
	});

	it('refreshes an expired upstream token before returning', async () => {
		const store = new InMemoryProxyStore();
		const id = store.putUpstreamToken({
			accessToken: 'OLD',
			refreshToken: 'WR',
			expiresAt: Date.now() - 1000,
		});
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		const refresh = vi
			.fn()
			.mockResolvedValue({ access_token: 'NEW', refresh_token: 'WR2', expires_in: 3600 });
		expect(await resolveUpstreamBearer(jwt, pc, store, refresh)).toBe('NEW');
		expect(store.getUpstreamToken(id)?.accessToken).toBe('NEW');
		expect(store.getUpstreamToken(id)?.refreshToken).toBe('WR2');
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('does not refresh a still-valid token', async () => {
		const store = new InMemoryProxyStore();
		const id = store.putUpstreamToken({
			accessToken: 'STILLGOOD',
			refreshToken: 'WR',
			expiresAt: Date.now() + 1e6,
		});
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		const refresh = vi.fn();
		expect(await resolveUpstreamBearer(jwt, pc, store, refresh)).toBe('STILLGOOD');
		expect(refresh).not.toHaveBeenCalled();
	});
});

function fakeRegistry(wikis: Record<string, Partial<WikiConfig>>): WikiRegistry {
	return {
		getAll: () => wikis as Record<string, WikiConfig>,
		get: (k: string) => wikis[k] as WikiConfig | undefined,
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => false,
	} as unknown as WikiRegistry;
}

function stubCreateServer(): McpServer {
	return new McpServer(
		{ name: 'proxy-bearer-test-server', version: '0.0.0' },
		{ capabilities: {} },
	);
}

// Pre-seeds a session whose transport.handleRequest captures the runtimeToken
// threaded into withRequestContext. POSTing with that mcp-session-id drives the
// existing-session branch, so the handler reaches the withRequestContext call
// without booting the real MCP transport machinery — the same fake-transport
// seam streamableHttp.test.ts uses.
function buildMcpApp(
	registry: WikiRegistry,
	getProxyConfig: ProxyConfigGetter | undefined,
	store: InMemoryProxyStore | undefined,
	captured: { token?: string; seen: boolean },
): Express {
	const app = express();
	app.use(express.json());
	const handleRequest = vi.fn(
		async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
			captured.seen = true;
			captured.token = getRuntimeToken();
			res.status(200).json({ ok: true });
		},
	);
	const transport = {
		sessionId: 'sid-1',
		handleRequest,
	} as unknown as SessionRegistry[string]['transport'];
	const sessions: SessionRegistry = { 'sid-1': { transport, activeRequests: 0 } };
	app.post(
		'/mcp',
		createMcpPostHandler(sessions, stubCreateServer, {
			wikiRegistry: registry,
			getProxyConfig,
			proxyStore: store,
		}),
	);
	return app;
}

const oauthWiki: Partial<WikiConfig> = {
	sitename: 'OAuthWiki',
	server: 'https://wiki.example',
	scriptpath: '/w',
	articlepath: '/wiki',
	oauth2ClientId: 'client-id-123',
};

const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('POST /mcp proxy bearer rewire', () => {
	it('threads the resolved UPSTREAM token (not the JWT) into the request context', async () => {
		const store = new InMemoryProxyStore();
		const id = store.putUpstreamToken({ accessToken: 'UPSTREAM-WA', expiresAt: Date.now() + 1e6 });
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${jwt}`)
			.send(body);

		expect(res.status).not.toBe(401);
		expect(captured.seen).toBe(true);
		// The UPSTREAM token, NOT the proxy JWT, is what mwn would call the wiki with.
		expect(captured.token).toBe('UPSTREAM-WA');
		expect(captured.token).not.toBe(jwt);
	});

	it('returns 401 + WWW-Authenticate for an invalid proxy JWT on a proxy wiki', async () => {
		const store = new InMemoryProxyStore();
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer not-a-real-jwt')
			.send(body);

		expect(res.status).toBe(401);
		expect(res.body?.error?.code).toBe(-32001);
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/Bearer realm="MediaWiki MCP Server"/);
		expect(wwwAuth).toMatch(/resource_metadata="/);
		expect(wwwAuth).toMatch(/\/.well-known\/oauth-protected-resource"/);
		// The request must NOT have reached the transport.
		expect(captured.seen).toBe(false);
	});

	it('serves a tokenless proxy request anonymously (no 401, undefined token)', async () => {
		const store = new InMemoryProxyStore();
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.send(body);

		expect(res.status).not.toBe(401);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBeUndefined();
	});

	it('leaves the legacy 401 challenge unchanged when the proxy is disabled', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		// Proxy disabled (getProxyConfig returns null, no store): the OAuth-only
		// wiki with no bearer must still get the legacy 401 short-circuit.
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => null, undefined, captured);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.send(body);

		expect(res.status).toBe(401);
		expect(res.body?.error?.code).toBe(-32001);
		expect(captured.seen).toBe(false);
	});

	it('forwards the raw bearer unchanged when the proxy is disabled (legacy passthrough)', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => null, undefined, captured);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer raw-wiki-token')
			.send(body);

		expect(res.status).not.toBe(401);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBe('raw-wiki-token');
	});
});
