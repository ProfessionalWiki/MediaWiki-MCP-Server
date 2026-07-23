import { describe, it, expect, vi } from 'vitest';

import express, { type Express } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	resolveUpstreamBearer,
	createMcpPostHandler,
	type ProxyConfigGetter,
	type McpPostHandlerOptions,
} from '../../src/transport/streamableHttp.js';
import type { SessionRegistry } from '../../src/transport/sessionRegistry.js';
import { OAuthFlowError } from '../../src/auth/oauthFlow.js';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.js';
import { mintAccessToken } from '../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import { getRuntimeToken } from '../../src/runtime/requestContext.js';

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
		// Pin the upstream token endpoint: the proactive-refresh path builds it from
		// tokenExchangeBase + scriptpath, and this is the only one of the shared
		// mwOauth2TokenEndpoint call sites otherwise not asserted by URL.
		expect(refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: 'http://mediawiki.svc:80/w/rest.php/oauth2/access_token',
			}),
		);
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

	it('falls back to the still-valid token when a proactive refresh fails transiently', async () => {
		const store = new InMemoryProxyStore();
		// Inside the 30s refresh skew, but not yet expired: the proactive refresh runs,
		// and when it blips the current token is still usable.
		const id = store.putUpstreamToken({
			accessToken: 'STILLGOOD',
			refreshToken: 'WR',
			expiresAt: Date.now() + 10_000,
		});
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('transient', 'wiki 503'));
		expect(await resolveUpstreamBearer(jwt, pc, store, refresh)).toBe('STILLGOOD');
		expect(refresh).toHaveBeenCalledOnce();
		// The stored token is left intact for the next attempt.
		expect(store.getUpstreamToken(id)?.accessToken).toBe('STILLGOOD');
	});

	it('throws a retryable error when an expired token cannot be refreshed transiently', async () => {
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
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('transient', 'wiki 503'));
		await expect(resolveUpstreamBearer(jwt, pc, store, refresh)).rejects.toMatchObject({
			retryable: true,
		});
	});

	it('throws a non-retryable error when an expired token refresh is rejected', async () => {
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
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('invalid_grant', 'dead'));
		await expect(resolveUpstreamBearer(jwt, pc, store, refresh)).rejects.toMatchObject({
			retryable: false,
		});
	});

	it('coalesces concurrent proactive refreshes into a single upstream call', async () => {
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
		// Slow upstream refresh so both callers are genuinely in flight at once.
		const refresh = vi
			.fn()
			.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ access_token: 'NEW', refresh_token: 'WR2', expires_in: 3600 }),
							15,
						),
					),
			);
		const [a, b] = await Promise.all([
			resolveUpstreamBearer(jwt, pc, store, refresh),
			resolveUpstreamBearer(jwt, pc, store, refresh),
		]);
		expect(a).toBe('NEW');
		expect(b).toBe('NEW');
		expect(refresh).toHaveBeenCalledOnce();
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
	refresh?: McpPostHandlerOptions['refresh'],
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
			refresh,
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
		expect(wwwAuth).toMatch(/^Bearer /);
		expect(wwwAuth).toMatch(/error="invalid_token"/);
		expect(wwwAuth).toMatch(/realm="MediaWiki MCP Server"/);
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

	it('returns 503 (not 401) when a proxy refresh fails transiently for an expired token', async () => {
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
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('transient', 'wiki 503'));
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured, refresh);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${jwt}`)
			.send(body);

		expect(res.status).toBe(503);
		// A 503 must NOT carry an invalid_token challenge, which would tell the client
		// to throw away its session and re-authenticate for a transient upstream blip.
		expect(res.headers['www-authenticate']).toBeUndefined();
		expect(captured.seen).toBe(false);
	});

	it('returns 401 with a re-auth challenge when an expired token refresh is rejected as a dead credential', async () => {
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
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('invalid_grant', 'dead'));
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured, refresh);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${jwt}`)
			.send(body);

		expect(res.status).toBe(401);
		// A dead credential DOES carry the discovery challenge so the client re-signs-in.
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/error="invalid_token"/);
		expect(captured.seen).toBe(false);
	});

	it('serves the request with the still-valid token when a proactive refresh fails transiently', async () => {
		const store = new InMemoryProxyStore();
		const id = store.putUpstreamToken({
			accessToken: 'STILLGOOD',
			refreshToken: 'WR',
			expiresAt: Date.now() + 10_000,
		});
		const jwt = await mintAccessToken({
			issuer: pc.issuer,
			signingKey: pc.signingKey,
			upstreamTokenId: id,
			ttlMs: 60_000,
			scopes: [],
		});
		const refresh = vi.fn().mockRejectedValue(new OAuthFlowError('transient', 'wiki 503'));
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = buildMcpApp(fakeRegistry({ test: oauthWiki }), () => pc, store, captured, refresh);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${jwt}`)
			.send(body);

		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(503);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBe('STILLGOOD');
	});
});
