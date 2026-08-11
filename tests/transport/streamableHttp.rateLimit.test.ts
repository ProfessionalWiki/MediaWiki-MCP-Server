// Rate limiting through the REAL buildApp wiring. The route-level tests in
// mcpRoute.test.ts build their own express app, so they cannot catch a
// regression in how buildApp mounts express.json — and that mounting is what
// decides whether a request body is parsed at all, and so whether the limiter
// can classify it. Both bypasses this file pins were invisible to a suite that
// stubbed either the handler or the app.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/server';
import { buildApp, type BuildAppDeps } from '../../src/transport/streamableHttp.ts';
import { createAppState } from '../../src/wikis/state.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { createRateLimiter } from '../../src/transport/rateLimit.ts';
import { RATE_LIMITED_ERROR_CODE } from '../../src/transport/errorCodes.ts';

const SETTINGS = {
	ratePerSecond: 1,
	burst: 2,
	anonymousRatePerSecond: 1,
	anonymousBurst: 2,
};

// The limiter refills from the clock it is handed, so any wall-clock advance of
// about a second between two of these requests earns a drained bucket a token
// back and serves a request the test expects to be refused. A slow round-trip
// does it; so does a Date.now() that steps, which a virtualised host can do
// while the requests themselves take milliseconds. Nothing here exercises
// refill: the bucket must stay exactly as drained as the requests left it.
const frozenClock = () => 1_000_000;

function makeDeps(calls: { count: number }): BuildAppDeps {
	return {
		state: createAppState({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test Wiki',
					server: 'http://wiki.invalid',
					articlepath: '/wiki',
					scriptpath: '/w',
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		}),
		getProxyConfig: () => null,
		proxyStore: new InMemoryProxyStore(),
		proxyRedirectPolicy: null,
		cimdResolver: null,
		defaultWikiKey: 'test',
		defaultWikiSitename: 'Test Wiki',
		createServerFn: () => {
			const server = new McpServer(
				{ name: 'rl-app', version: '0.0.0' },
				{ capabilities: { tools: {} } },
			);
			server.registerTool('ping', { description: 'test tool', inputSchema: {} }, () => {
				calls.count++;
				return { content: [{ type: 'text' as const, text: 'pong' }] };
			});
			return server;
		},
		host: '127.0.0.1',
		allowedHosts: undefined,
		allowedOrigins: [],
		maxRequestBody: '1mb',
		rateLimiter: createRateLimiter(SETTINGS, frozenClock),
	};
}

const call = (id: number) => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name: 'ping', arguments: {} },
});

describe('rate limiting through the real app', () => {
	it('refuses a plain tools/call once the bucket is drained', async () => {
		const calls = { count: 0 };
		const { app } = buildApp(makeDeps(calls));
		const send = () =>
			request(app).post('/mcp').set('Accept', 'application/json, text/event-stream').send(call(1));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		const refused = await send();
		expect(refused.status).toBe(429);
		expect(refused.headers['retry-after']).toBeDefined();
		expect(refused.body).toMatchObject({ error: { code: RATE_LIMITED_ERROR_CODE } });
		expect(calls.count).toBe(2);
	});

	it('meters a Content-Type that body-parser would not parse by default', async () => {
		const calls = { count: 0 };
		const { app } = buildApp(makeDeps(calls));
		// The SDK accepts `application/json;`, but body-parser's DEFAULT type
		// matcher rejects it. Mounted with the default, express leaves req.body
		// undefined, the limiter sees no tools/call, and the SDK still reads the
		// raw stream — so the tool runs unmetered. buildApp must mount
		// express.json with the SDK's own predicate for this to be limited.
		const send = () =>
			request(app)
				.post('/mcp')
				.set('Content-Type', 'application/json;')
				.set('Accept', 'application/json, text/event-stream')
				.send(JSON.stringify(call(1)));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(429);
		expect(calls.count).toBe(2);
	});

	it('applies the request-size cap to that Content-Type too', async () => {
		const calls = { count: 0 };
		const deps = { ...makeDeps(calls), maxRequestBody: '1kb' };
		const { app } = buildApp(deps);
		const oversized = {
			...call(1),
			params: { name: 'ping', arguments: { pad: 'x'.repeat(4096) } },
		};
		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json;')
			.set('Accept', 'application/json, text/event-stream')
			.send(JSON.stringify(oversized));
		expect(res.status).toBe(413);
		expect(calls.count).toBe(0);
	});

	it('charges a JSON-RPC batch one token per tools/call entry', async () => {
		const calls = { count: 0 };
		const { app } = buildApp(makeDeps(calls));
		// Burst is 2, so a batch of 5 cannot be paid for and none of it may run.
		const res = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send([call(1), call(2), call(3), call(4), call(5)]);
		expect(res.status).toBe(429);
		expect(calls.count).toBe(0);
	});

	it('lets a batch through while its whole cost fits', async () => {
		const calls = { count: 0 };
		const { app } = buildApp(makeDeps(calls));
		const first = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send([call(1), call(2)]);
		expect(first.status).toBe(200);
		expect(calls.count).toBe(2);
		const second = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send(call(3));
		expect(second.status).toBe(429);
	});
});
