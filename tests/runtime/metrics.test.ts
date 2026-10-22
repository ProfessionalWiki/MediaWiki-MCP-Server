import { describe, it, expect, beforeEach } from 'vitest';
import { readMetrics, type Metrics } from '../../src/runtime/metrics.ts';
import { liveMetrics, metricsOff, scrape } from '../helpers/metrics.ts';

describe('readMetrics', () => {
	it('records on the HTTP transport when MCP_METRICS is true', () => {
		expect(readMetrics({ MCP_METRICS: 'true' }, 'http').exposition).toBeDefined();
	});

	it('is off when MCP_METRICS is not true', () => {
		expect(readMetrics({ MCP_METRICS: 'false' }, 'http').exposition).toBeUndefined();
	});

	it('is off when MCP_METRICS is unset', () => {
		expect(readMetrics({}, 'http').exposition).toBeUndefined();
	});

	it('is off on stdio, which has no /metrics to serve', () => {
		expect(readMetrics({ MCP_METRICS: 'true' }, 'stdio').exposition).toBeUndefined();
	});
});

describe('metrics that are off', () => {
	it('accept every recording without throwing', () => {
		const metrics = metricsOff();
		expect(() =>
			metrics.recordToolCall({
				tool: 't',
				wiki: 'w',
				outcome: 'success',
				durationMs: 1,
				upstreamStatus: undefined,
			}),
		).not.toThrow();
		expect(() => metrics.recordReadyFailure()).not.toThrow();
		expect(() => metrics.recordRateLimited('anonymous')).not.toThrow();
		expect(() => metrics.setInFlightProvider(() => 0)).not.toThrow();
		expect(() => metrics.setSubscriptionStreamsProvider(() => 0)).not.toThrow();
		expect(() => metrics.recordStoreFlush(1)).not.toThrow();
		expect(() => metrics.recordStoreFlushFailure()).not.toThrow();
		expect(() =>
			metrics.setProxyStoreStatsProvider(() => ({ upstreamTokens: 0, clients: 0 })),
		).not.toThrow();
	});
});

describe('live metrics', () => {
	let metrics: Metrics;

	beforeEach(() => {
		metrics = liveMetrics();
	});

	it('are exposed in the Prometheus text format', () => {
		expect(metrics.exposition?.contentType).toContain('text/plain');
	});

	it('increments mcp_tool_calls_total with tool/wiki/outcome labels', async () => {
		metrics.recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 12,
			upstreamStatus: undefined,
		});
		metrics.recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 7,
			upstreamStatus: undefined,
		});
		const body = await scrape(metrics);
		expect(body).toMatch(
			/mcp_tool_calls_total\{tool="get-page",wiki="example\.org",outcome="success"\} 2/,
		);
	});

	it('observes mcp_tool_call_duration_seconds', async () => {
		metrics.recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 25,
			upstreamStatus: undefined,
		});
		const body = await scrape(metrics);
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_count{tool="get-page",wiki="example.org"} 1',
		);
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_sum{tool="get-page",wiki="example.org"} 0.025',
		);
	});

	it('increments mcp_upstream_status_total only when upstreamStatus is set', async () => {
		metrics.recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'upstream_failure',
			durationMs: 5,
			upstreamStatus: 503,
		});
		metrics.recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 5,
			upstreamStatus: undefined,
		});
		const body = await scrape(metrics);
		expect(body).toMatch(
			/mcp_upstream_status_total\{tool="get-page",wiki="example\.org",status="503"\} 1/,
		);
		expect(body).not.toMatch(/mcp_upstream_status_total\{[^}]*status="undefined"/);
	});

	it('increments mcp_ready_failures_total', async () => {
		metrics.recordReadyFailure();
		metrics.recordReadyFailure();
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_ready_failures_total 2/);
	});

	it('increments mcp_rate_limited_total by caller', async () => {
		metrics.recordRateLimited('anonymous');
		metrics.recordRateLimited('anonymous');
		metrics.recordRateLimited('caller');
		const body = await scrape(metrics);
		expect(body).toContain('mcp_rate_limited_total{caller="anonymous"} 2');
		expect(body).toContain('mcp_rate_limited_total{caller="caller"} 1');
	});

	it('mcp_inflight_requests reads provider lazily at scrape', async () => {
		let count = 3;
		metrics.setInFlightProvider(() => count);
		let body = await scrape(metrics);
		expect(body).toMatch(/mcp_inflight_requests 3/);
		count = 7;
		body = await scrape(metrics);
		expect(body).toMatch(/mcp_inflight_requests 7/);
	});

	it('mcp_subscription_streams reads provider lazily at scrape', async () => {
		metrics.setSubscriptionStreamsProvider(() => 2);
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_subscription_streams 2/);
	});

	it('both replacement gauges report 0 when no provider set', async () => {
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_inflight_requests 0/);
		expect(body).toMatch(/mcp_subscription_streams 0/);
	});

	it('observes mcp_proxy_store_flush_duration_seconds', async () => {
		metrics.recordStoreFlush(5);
		metrics.recordStoreFlush(5);
		const body = await scrape(metrics);
		expect(body).toContain('mcp_proxy_store_flush_duration_seconds_count 2');
		expect(body).toContain('mcp_proxy_store_flush_duration_seconds_sum 0.01');
	});

	it('mcp_proxy_store gauges read the stats provider lazily at scrape', async () => {
		let stats = { upstreamTokens: 2, clients: 1 };
		metrics.setProxyStoreStatsProvider(() => stats);
		let body = await scrape(metrics);
		expect(body).toMatch(/mcp_proxy_store_upstream_tokens 2/);
		expect(body).toMatch(/mcp_proxy_store_clients 1/);
		stats = { upstreamTokens: 5, clients: 3 };
		body = await scrape(metrics);
		expect(body).toMatch(/mcp_proxy_store_upstream_tokens 5/);
		expect(body).toMatch(/mcp_proxy_store_clients 3/);
	});

	it('counts mcp_proxy_store_flush_failures_total', async () => {
		metrics.recordStoreFlushFailure();
		metrics.recordStoreFlushFailure();
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_proxy_store_flush_failures_total 2/);
	});

	it('mcp_proxy_store gauges report 0 when no provider set', async () => {
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_proxy_store_upstream_tokens 0/);
		expect(body).toMatch(/mcp_proxy_store_clients 0/);
	});

	it('keeps its counts apart from another live metrics object', async () => {
		liveMetrics().recordReadyFailure();
		metrics.recordReadyFailure();
		const body = await scrape(metrics);
		expect(body).toMatch(/mcp_ready_failures_total 1/);
	});

	it('histogram exposes the documented bucket boundaries', async () => {
		metrics.recordToolCall({
			tool: 't',
			wiki: 'w',
			outcome: 'success',
			durationMs: 100,
			upstreamStatus: undefined,
		});
		const body = await scrape(metrics);
		for (const le of [
			'0.005',
			'0.01',
			'0.025',
			'0.05',
			'0.1',
			'0.25',
			'0.5',
			'1',
			'2.5',
			'5',
			'10',
		]) {
			expect(body).toContain(`le="${le}"`);
		}
	});
});
