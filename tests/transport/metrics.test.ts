import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockRequest = vi.fn();

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

const mockWikiSelection = {
	getCurrent: () => ({ key: 'example.org', config: {} }),
	setCurrent: () => {},
	reset: () => {},
};

const mockMwnProvider = {
	get: async () => ({ request: mockRequest }),
	invalidate: () => {},
};

function makeApp(): express.Express {
	const app = express();
	mountMetricsEndpoint(app);
	mountReadyEndpoint(app, {
		wikiSelection: mockWikiSelection as never,
		mwnProvider: mockMwnProvider as never,
	});
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
