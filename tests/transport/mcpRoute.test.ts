import { describe, it, expect, afterEach, vi } from 'vitest';

import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { createMcpHandler, isJsonContentType, McpServer } from '@modelcontextprotocol/server';
import {
	createMcpRouteHandler,
	extractBearerToken,
	type McpRouteOptions,
	type ProxyConfigGetter,
} from '../../src/transport/mcpRoute.ts';
import { createRateLimiter } from '../../src/transport/rateLimit.ts';
import { RATE_LIMITED_ERROR_CODE } from '../../src/transport/errorCodes.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { mintAccessToken } from '../../src/auth/authorizationServer/jwt.ts';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.ts';
import { getRuntimeToken } from '../../src/runtime/requestContext.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';

afterEach(() => {
	vi.unstubAllEnvs();
});

function req(authorization: string | undefined): Request {
	return { headers: { authorization } } as unknown as Request;
}

describe('extractBearerToken', () => {
	it('returns the token for a standard Bearer header', () => {
		expect(extractBearerToken(req('Bearer abc123'))).toBe('abc123');
	});
	it('is case-insensitive on the scheme', () => {
		expect(extractBearerToken(req('bearer abc123'))).toBe('abc123');
		expect(extractBearerToken(req('BEARER abc123'))).toBe('abc123');
	});
	it('trims whitespace around the token', () => {
		expect(extractBearerToken(req('Bearer   abc123  '))).toBe('abc123');
	});
	it('returns undefined for whitespace-only tokens', () => {
		expect(extractBearerToken(req('Bearer   \t'))).toBeUndefined();
		expect(extractBearerToken(req('Bearer '))).toBeUndefined();
	});
	it('returns undefined when header is missing', () => {
		expect(extractBearerToken(req(undefined))).toBeUndefined();
	});
	it('returns undefined for non-Bearer schemes', () => {
		expect(extractBearerToken(req('Basic xyz'))).toBeUndefined();
		expect(extractBearerToken(req('Digest xyz'))).toBeUndefined();
	});
	it('takes the first well-formed value from comma-joined duplicate headers', () => {
		expect(extractBearerToken(req('Bearer abc, Bearer def'))).toBe('abc');
	});
	it('returns undefined if the first comma-joined value is not Bearer', () => {
		expect(extractBearerToken(req(', Bearer abc'))).toBeUndefined();
		expect(extractBearerToken(req('Basic xyz, Bearer abc'))).toBeUndefined();
	});
});

function buildEraApp(): Express {
	const app = express();
	app.use(express.json());
	const handler = createMcpHandler(
		() => {
			const server = new McpServer(
				{ name: 'era-test-server', version: '0.0.0' },
				{ capabilities: { tools: {} } },
			);
			return server;
		},
		{ legacy: 'stateless' },
	);
	const route = createMcpRouteHandler(handler);
	app.post('/mcp', route);
	app.get('/mcp', route);
	app.delete('/mcp', route);
	return app;
}

const initializeBody = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'era-test-client', version: '0.0.0' },
	},
};

describe('era routing on /mcp', () => {
	it('serves a legacy initialize statelessly: 200 with NO session id header', async () => {
		const res = await request(buildEraApp())
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send(initializeBody);
		expect(res.status).toBe(200);
		expect(res.headers['mcp-session-id']).toBeUndefined();
	});

	it('serves a legacy tools/list without any session id', async () => {
		const res = await request(buildEraApp())
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(res.text).toContain('"tools"');
	});

	it('answers GET /mcp with 405 (no standalone SSE stream without sessions)', async () => {
		const res = await request(buildEraApp()).get('/mcp').set('Accept', 'text/event-stream');
		expect(res.status).toBe(405);
	});

	it('answers DELETE /mcp with 405 (no session to terminate)', async () => {
		const res = await request(buildEraApp()).delete('/mcp');
		expect(res.status).toBe(405);
	});
});

describe('bearer threading through the route', () => {
	function oauthRegistry(): WikiRegistry {
		return {
			getAll: () => ({ ex: { oauth2ClientId: 'CID' } }),
			get: () => ({ oauth2ClientId: 'CID' }),
		} as unknown as WikiRegistry;
	}

	function buildCaptureApp(captured: { token?: string; seen: boolean }): Express {
		const app = express();
		app.use(express.json());
		const fakeHandler = {
			fetch: async (): Promise<Response> => {
				captured.seen = true;
				captured.token = getRuntimeToken();
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		};
		app.post('/mcp', createMcpRouteHandler(fakeHandler, { wikiRegistry: oauthRegistry() }));
		return app;
	}

	it('refuses a caller-supplied bearer when forwarding is not opted into', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const res = await request(buildCaptureApp(captured))
			.post('/mcp')
			.set('Authorization', 'Bearer raw-wiki-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		// The token was issued by the wiki's authorization server, not for this
		// server. Refused rather than forwarded, and rather than ignored — ignoring
		// it would run the request anonymously while the caller believed otherwise.
		expect(res.status).toBe(401);
		expect(captured.seen).toBe(false);
	});

	it('refuses a bearer even when no wiki configures OAuth sign-in', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const app = express();
		app.use(express.json());
		const fakeHandler = {
			fetch: async (): Promise<Response> => {
				captured.seen = true;
				captured.token = getRuntimeToken();
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		};
		// No oauth2ClientId anywhere — the shape of the documented public read-only
		// and manual-token deployments.
		const registry = {
			getAll: () => ({ ex: { sitename: 'Ex' } }),
			get: () => ({ sitename: 'Ex' }),
		} as unknown as WikiRegistry;
		app.post('/mcp', createMcpRouteHandler(fakeHandler, { wikiRegistry: registry }));

		const res = await request(app)
			.post('/mcp')
			.set('Authorization', 'Bearer raw-wiki-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		// `oauth2ClientId` describes how THIS server runs browser sign-in, not whether
		// the wiki accepts bearers — any wiki with Extension:OAuth does. Keying the
		// refusal on it would forward the token on exactly these deployments.
		expect(res.status).toBe(401);
		expect(captured.seen).toBe(false);
		expect(captured.token).toBeUndefined();
	});

	it('threads the raw bearer into the request context once forwarding is opted into', async () => {
		vi.stubEnv('MCP_ALLOW_BEARER_PASSTHROUGH', 'true');
		const captured: { token?: string; seen: boolean } = { seen: false };
		const res = await request(buildCaptureApp(captured))
			.post('/mcp')
			.set('Authorization', 'Bearer raw-wiki-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBe('raw-wiki-token');
	});

	it('leaves the context tokenless for an anonymous request', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const res = await request(buildCaptureApp(captured))
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBeUndefined();
	});
});

// The limiter refills from the clock it is handed, so any advance of about a
// second between two of these requests earns a drained bucket a token back and
// serves a request the test expects to be refused, which a slow round-trip is
// enough to do. No rate-limit test below exercises refill: the bucket must stay
// exactly as drained as the requests left it.
const frozenClock = () => 1_000_000;

describe('rate limiting on /mcp', () => {
	const SETTINGS = {
		ratePerSecond: 1,
		burst: 2,
		anonymousRatePerSecond: 1,
		anonymousBurst: 2,
	};

	function buildLimitedApp(
		captured: { calls: number },
		options: Partial<McpRouteOptions> = {},
	): Express {
		const app = express();
		app.use(express.json());
		const fakeHandler = {
			fetch: async (): Promise<Response> => {
				captured.calls++;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		};
		app.post(
			'/mcp',
			createMcpRouteHandler(fakeHandler, {
				rateLimiter: createRateLimiter(SETTINGS, frozenClock),
				...options,
			}),
		);
		return app;
	}

	const toolsCall = (id: number) => ({
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'get-page', arguments: { title: 'X' } },
	});

	it('refuses tools/call over the limit with 429, Retry-After, and the request id', async () => {
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured);
		expect((await request(app).post('/mcp').send(toolsCall(1))).status).toBe(200);
		expect((await request(app).post('/mcp').send(toolsCall(2))).status).toBe(200);

		const refused = await request(app).post('/mcp').send(toolsCall(7));
		expect(refused.status).toBe(429);
		expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
		expect(refused.body).toMatchObject({
			jsonrpc: '2.0',
			error: { code: RATE_LIMITED_ERROR_CODE },
			id: 7,
		});
		// The refused call never reached the MCP handler.
		expect(captured.calls).toBe(2);
	});

	it('limits only tools/call: discovery and listen streams pass a drained bucket', async () => {
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured);
		await request(app).post('/mcp').send(toolsCall(1));
		await request(app).post('/mcp').send(toolsCall(2));
		expect((await request(app).post('/mcp').send(toolsCall(3))).status).toBe(429);

		const list = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
		expect(list.status).toBe(200);
		const listen = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 5, method: 'subscriptions/listen', params: {} });
		expect(listen.status).toBe(200);
	});

	it('shares one bucket across anonymous callers', async () => {
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured);
		// Different supertest agents, same anonymous bucket.
		await request(app).post('/mcp').send(toolsCall(1));
		await request(app).post('/mcp').send(toolsCall(2));
		expect((await request(app).post('/mcp').send(toolsCall(3))).status).toBe(429);
	});

	it('caps forwarded bearers in aggregate, so rotating tokens cannot evade the limit', async () => {
		vi.stubEnv('MCP_ALLOW_BEARER_PASSTHROUGH', 'true');
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured);
		const asBearer = (token: string, id: number) =>
			request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send(toolsCall(id));

		// This server never verifies a forwarded bearer, so a per-token bucket alone
		// would hand a fresh allowance to every random token. A shared allowance is
		// charged as well: ten distinct tokens get the burst between them, not each.
		let allowed = 0;
		for (let i = 0; i < 10; i++) {
			if ((await asBearer(`rotating-${i}`, i)).status === 200) {
				allowed++;
			}
		}
		expect(allowed).toBe(SETTINGS.burst);
		expect(captured.calls).toBe(SETTINGS.burst);
		// Anonymous traffic keeps its own allowance regardless.
		expect((await request(app).post('/mcp').send(toolsCall(99))).status).toBe(200);
	});

	it('charges a forwarded bearer its own bucket as well as the shared one', async () => {
		vi.stubEnv('MCP_ALLOW_BEARER_PASSTHROUGH', 'true');
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured);
		const asBearer = (token: string, id: number) =>
			request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send(toolsCall(id));

		// One token spending the whole burst is refused on its own bucket too, so
		// the shared cap did not replace per-caller fairness.
		for (let i = 0; i < SETTINGS.burst; i++) {
			expect((await asBearer('token-a', i)).status).toBe(200);
		}
		expect((await asBearer('token-a', 90)).status).toBe(429);
	});

	it('keys proxy callers by their upstream token id', async () => {
		const store = new InMemoryProxyStore();
		const pcLocal = {
			issuer: 'https://wiki.example/mcp',
			signingKey: 'k'.repeat(32),
		} as unknown as ProxyConfig;
		const mint = async (accessToken: string) =>
			mintAccessToken({
				issuer: pcLocal.issuer,
				signingKey: pcLocal.signingKey,
				upstreamTokenId: store.putUpstreamToken({ accessToken, expiresAt: Date.now() + 1e6 }),
				ttlMs: 60_000,
				scopes: [],
			});
		const jwtA = await mint('upstream-a');
		const jwtB = await mint('upstream-b');

		const captured = { calls: 0 };
		const app = buildLimitedApp(captured, {
			getProxyConfig: (() => pcLocal) as ProxyConfigGetter,
			proxyStore: store,
		});
		const asJwt = (jwt: string, id: number) =>
			request(app).post('/mcp').set('Authorization', `Bearer ${jwt}`).send(toolsCall(id));

		await asJwt(jwtA, 1);
		await asJwt(jwtA, 2);
		expect((await asJwt(jwtA, 3)).status).toBe(429);
		// A different signed-in user is not throttled by user A's drained bucket.
		expect((await asJwt(jwtB, 4)).status).toBe(200);
	});

	it('applies no limit when the limiter is absent', async () => {
		const captured = { calls: 0 };
		const app = buildLimitedApp(captured, { rateLimiter: undefined });
		for (let i = 0; i < 20; i++) {
			expect((await request(app).post('/mcp').send(toolsCall(i))).status).toBe(200);
		}
		expect(captured.calls).toBe(20);
	});
});

// The bypasses these cover both survived a limiter test suite that stubbed
// handler.fetch: the batch array and the unparsed body are decided by how the
// REAL request reaches the REAL handler, so these drive both.
describe('rate limiting cannot be bypassed by request shape', () => {
	const SETTINGS = {
		ratePerSecond: 1,
		burst: 2,
		anonymousRatePerSecond: 1,
		anonymousBurst: 2,
	};

	// Mirrors the production wiring: a real MCP handler, and express.json with the
	// SDK's own content-type predicate.
	function buildRealApp(calls: { count: number }): Express {
		const app = express();
		app.use(express.json({ type: (req) => isJsonContentType(req.headers['content-type']) }));
		const handler = createMcpHandler(
			() => {
				const server = new McpServer(
					{ name: 'rl-test-server', version: '0.0.0' },
					{ capabilities: { tools: {} } },
				);
				server.registerTool('ping', { description: 'test tool', inputSchema: {} }, () => {
					calls.count++;
					return { content: [{ type: 'text' as const, text: 'pong' }] };
				});
				return server;
			},
			{ legacy: 'stateless' },
		);
		app.post(
			'/mcp',
			createMcpRouteHandler(handler, { rateLimiter: createRateLimiter(SETTINGS, frozenClock) }),
		);
		return app;
	}

	const call = (id: number) => ({
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'ping', arguments: {} },
	});

	it('charges a JSON-RPC batch one token per tools/call entry', async () => {
		const calls = { count: 0 };
		const app = buildRealApp(calls);
		// Burst is 2. A batch of 5 tool calls cannot be paid for, so none of them
		// may run — wrapping calls in an array must not buy extra capacity.
		const res = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send([call(1), call(2), call(3), call(4), call(5)]);
		expect(res.status).toBe(429);
		expect(calls.count).toBe(0);
	});

	it('lets a batch through only while its whole cost fits, then refuses', async () => {
		const calls = { count: 0 };
		const app = buildRealApp(calls);
		const first = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send([call(1), call(2)]);
		expect(first.status).toBe(200);
		expect(calls.count).toBe(2);
		// The bucket is now drained, so a single further call is refused.
		const second = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send(call(3));
		expect(second.status).toBe(429);
		expect(calls.count).toBe(2);
	});

	it('limits a request whose Content-Type body-parser would not parse', async () => {
		const calls = { count: 0 };
		const app = buildRealApp(calls);
		// `application/json;` is accepted by the SDK but rejected by body-parser's
		// default matcher. Parsed by the wrong predicate, req.body is undefined,
		// the request looks like a non-tool call, and the tool runs unmetered.
		const send = () =>
			request(app)
				.post('/mcp')
				.set('Content-Type', 'application/json;')
				.set('Accept', 'application/json, text/event-stream')
				.send(JSON.stringify(call(1)));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		const refused = await send();
		expect(refused.status).toBe(429);
		expect(calls.count).toBe(2);
	});
});
