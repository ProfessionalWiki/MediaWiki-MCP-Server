import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRequest = vi.fn();

// Two mock layers are needed and they serve different purposes:
//
// 1. The vi.mock() calls below intercept module imports so that the top-level
//    bootstrap in streamableHttp.ts (loadConfigFromFile, evaluateBearerGuard,
//    emitStartupBanner, app.listen) can run on import without needing a real
//    config.json or a reachable wiki. These keep the *module's own* state
//    benign so importing it doesn't crash.
//
// 2. The mockWikiSelection and mockMwnProvider objects below are passed
//    explicitly to mountReadyEndpoint() in each test's makeApp(). The tests
//    create their own express app independent of the module-level one, so
//    these inline mocks are what actually drive the test logic. Do not
//    collapse the two layers — they target different code paths.

vi.mock('../../src/config/loadConfig.js', () => ({
	loadConfigFromFile: () => ({
		defaultWiki: 'example.org',
		wikis: {
			'example.org': {
				sitename: 'Example',
				server: 'https://example.org',
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
		get = async () => ({ request: mockRequest });
		invalidate = () => {};
	},
}));

import express from 'express';
import request from 'supertest';
import {
	mountMetricsEndpoint,
	mountReadyEndpoint,
	__resetReadyCacheForTesting,
} from '../../src/transport/streamableHttp.js';
import { __resetMetricsForTesting, setSessionsProvider } from '../../src/runtime/metrics.js';
import type { WikiSelection } from '../../src/wikis/wikiSelection.js';
import type { MwnProvider } from '../../src/wikis/mwnProvider.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

const exampleWikiConfig: WikiConfig = {
	sitename: 'Example',
	server: 'https://example.org',
	articlepath: '/wiki',
	scriptpath: '/w',
};

const mockWikiSelection: WikiSelection = {
	getCurrent: () => ({ key: 'example.org', config: exampleWikiConfig }),
	setCurrent: () => {},
	reset: () => {},
};

const mockMwnProvider: MwnProvider = {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Mwn has 100+ methods; tests only use request().
	get: async () => ({ request: mockRequest }) as never,
	invalidate: () => {},
};

function makeApp(): express.Express {
	const app = express();
	mountMetricsEndpoint(app);
	mountReadyEndpoint(app, { wikiSelection: mockWikiSelection, mwnProvider: mockMwnProvider });
	return app;
}

describe('GET /metrics — disabled', () => {
	beforeEach(() => {
		delete process.env.MCP_METRICS;
		__resetMetricsForTesting();
		__resetReadyCacheForTesting();
		mockRequest.mockReset();
	});

	it('returns 404 when MCP_METRICS is unset', async () => {
		const res = await request(makeApp()).get('/metrics');
		expect(res.status).toBe(404);
	});
});

describe('GET /metrics — enabled', () => {
	beforeEach(() => {
		process.env.MCP_METRICS = 'true';
		__resetMetricsForTesting();
		__resetReadyCacheForTesting();
		mockRequest.mockReset();
	});

	afterEach(() => {
		delete process.env.MCP_METRICS;
		__resetMetricsForTesting();
	});

	it('returns 200 with prom-client content type and HELP lines', async () => {
		const res = await request(makeApp()).get('/metrics');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/plain');
		expect(res.text).toContain('# HELP mcp_tool_calls_total');
		expect(res.text).toContain('# HELP mcp_tool_call_duration_seconds');
		expect(res.text).toContain('# HELP mcp_active_sessions');
		expect(res.text).toContain('# HELP mcp_ready_failures_total');
	});

	it('mcp_ready_failures_total increments when /ready returns 503', async () => {
		mockRequest.mockRejectedValue(new Error('upstream down'));
		const app = makeApp();
		const ready = await request(app).get('/ready');
		expect(ready.status).toBe(503);
		const metrics = await request(app).get('/metrics');
		expect(metrics.text).toMatch(/mcp_ready_failures_total 1/);
	});

	it('mcp_ready_failures_total does not double-count cached 503 replays', async () => {
		mockRequest.mockRejectedValue(new Error('upstream down'));
		const app = makeApp();
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

	it('mcp_active_sessions reads the configured provider', async () => {
		const app = makeApp();
		setSessionsProvider(() => 4);
		const res = await request(app).get('/metrics');
		expect(res.text).toMatch(/mcp_active_sessions 4/);
	});
});
