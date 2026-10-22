import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRequest = vi.fn();

// The default wiki's key and mockMwnProvider are passed explicitly to mountReadyEndpoint()
// in each test's makeApp(): the tests build their own express app and these inline
// stubs drive the probe. streamableHttp.ts no longer runs any boot on import, so no
// module-level loadConfig/mwnProvider mock is needed.

import express from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/server';
import {
	buildApp,
	mountMetricsEndpoint,
	type BuildAppDeps,
} from '../../src/transport/streamableHttp.ts';
import { mountReadyEndpoint } from '../../src/transport/ready.ts';
import type { Metrics } from '../../src/runtime/metrics.ts';
import type { MwnProvider } from '../../src/wikis/mwnProvider.ts';
import { readAuthPolicy } from '../../src/runtime/authShape.ts';
import { createAppState } from '../../src/wikis/state.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { fakeHostedProxy } from '../helpers/fakeHostedProxy.ts';
import { fakeProxyConfig } from '../helpers/fakeProxyConfig.ts';
import { liveMetrics, metricsOff, scrape } from '../helpers/metrics.ts';

const mockMwnProvider: MwnProvider = {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Mwn has 100+ methods; tests only use request().
	get: async () => ({ request: mockRequest }) as never,
	invalidate: () => {},
};

function makeApp(metrics: Metrics): express.Express {
	const app = express();
	mountMetricsEndpoint(app, metrics);
	mountReadyEndpoint(app, {
		defaultWikiKey: 'example.org',
		mwnProvider: mockMwnProvider,
		metrics,
	});
	return app;
}

beforeEach(() => {
	mockRequest.mockReset();
});

describe('GET /metrics — enabled', () => {
	it('returns 200 with prom-client content type and HELP lines', async () => {
		const res = await request(makeApp(liveMetrics())).get('/metrics');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/plain');
		expect(res.text).toContain('# HELP mcp_tool_calls_total');
		expect(res.text).toContain('# HELP mcp_tool_call_duration_seconds');
		expect(res.text).toContain('# HELP mcp_inflight_requests');
		expect(res.text).toContain('# HELP mcp_subscription_streams');
		expect(res.text).toContain('# HELP mcp_ready_failures_total');
	});

	it('mcp_ready_failures_total increments when /ready returns 503', async () => {
		mockRequest.mockRejectedValue(new Error('upstream down'));
		const app = makeApp(liveMetrics());
		const ready = await request(app).get('/ready');
		expect(ready.status).toBe(503);
		const metrics = await request(app).get('/metrics');
		expect(metrics.text).toMatch(/mcp_ready_failures_total 1/);
	});

	it('mcp_ready_failures_total counts one failure for concurrent probes', async () => {
		// One outage, three simultaneous readiness probes: they share a single
		// probe, so only the request that started it records the failure. The
		// failure has to be slower than the requests take to arrive, or the first
		// probe finishes and fills the cache before the others reach the handler.
		mockRequest.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					setTimeout(() => reject(new Error('upstream down')), 50);
				}),
		);
		const app = makeApp(liveMetrics());
		const responses = await Promise.all([
			request(app).get('/ready'),
			request(app).get('/ready'),
			request(app).get('/ready'),
		]);
		for (const res of responses) {
			expect(res.status).toBe(503);
		}
		const metrics = await request(app).get('/metrics');
		expect(metrics.text).toMatch(/mcp_ready_failures_total 1/);
	});

	it('mcp_ready_failures_total does not double-count cached 503 replays', async () => {
		mockRequest.mockRejectedValue(new Error('upstream down'));
		const app = makeApp(liveMetrics());
		// Two consecutive probes within the cache TTL — second hits the cache
		// and must not re-increment the counter.
		const first = await request(app).get('/ready');
		const second = await request(app).get('/ready');
		expect(first.status).toBe(503);
		expect(second.status).toBe(503);
		expect(mockRequest).toHaveBeenCalledTimes(1);
		const metrics = await request(app).get('/metrics');
		expect(metrics.text).toMatch(/mcp_ready_failures_total 1/);
	});
});

describe('GET /metrics — served by buildApp', () => {
	function deps(overrides: Partial<BuildAppDeps>): BuildAppDeps {
		return {
			state: {
				...createAppState({
					defaultWiki: 'test',
					wikis: {
						test: {
							sitename: 'Test Wiki',
							server: 'https://wiki.example',
							articlepath: '/wiki',
							scriptpath: '/w',
							token: null,
							username: null,
							password: null,
						},
					},
					uploadDirs: [],
				}),
				mwnProvider: mockMwnProvider,
			},
			auth: readAuthPolicy({}, 'http', null, null),
			createServerFn: stubServer,
			host: '127.0.0.1',
			allowedOrigins: [],
			maxRequestBody: '1mb',
			metrics: metricsOff(),
			...overrides,
		};
	}

	function stubServer(): McpServer {
		return new McpServer({ name: 'metrics', version: '0.0.0' }, { capabilities: {} });
	}

	function gate(): { passed: Promise<void>; pass: () => void } {
		let pass = (): void => {};
		const passed = new Promise<void>((resolve) => {
			pass = resolve;
		});
		return { passed, pass };
	}

	it('is not served when metrics are off', async () => {
		const { app } = buildApp(deps({ metrics: metricsOff() }));

		const res = await request(app).get('/metrics');

		expect(res.status).toBe(404);
	});

	it('reports the hosted proxy store size', async () => {
		const store = new InMemoryProxyStore();
		store.putUpstreamToken({ accessToken: 'a', expiresAt: 1 });
		store.putUpstreamToken({ accessToken: 'b', expiresAt: 1 });
		const auth = readAuthPolicy({}, 'http', fakeHostedProxy(fakeProxyConfig(), store), null);
		const { app } = buildApp(deps({ auth, metrics: liveMetrics() }));

		const res = await request(app).get('/metrics');

		expect(res.text).toMatch(/mcp_proxy_store_upstream_tokens 2/);
	});

	it('counts a failed /ready probe', async () => {
		mockRequest.mockRejectedValue(new Error('upstream down'));
		const metrics = liveMetrics();
		const { app } = buildApp(deps({ metrics }));

		await request(app).get('/ready');

		expect(await scrape(metrics)).toMatch(/mcp_ready_failures_total 1/);
	});

	it('counts a request under /mcp while it is being served', async () => {
		const metrics = liveMetrics();
		const serving = gate();
		const release = gate();
		const { app } = buildApp(
			deps({
				metrics,
				createServerFn: async () => {
					serving.pass();
					await release.passed;
					return stubServer();
				},
			}),
		);
		const pending = request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
			.then((res) => res);
		await serving.passed;

		const body = await scrape(metrics);
		release.pass();
		await pending;

		expect(body).toMatch(/mcp_inflight_requests 1/);
	});
});
