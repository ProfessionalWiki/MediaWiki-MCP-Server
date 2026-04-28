import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
	initMetrics,
	isMetricsEnabled,
	recordToolCall,
	recordReadyFailure,
	setSessionsProvider,
	getMetricsHandler,
	__resetMetricsForTesting,
} from '../../src/runtime/metrics.js';

describe('metrics module — disabled state', () => {
	beforeEach(() => {
		__resetMetricsForTesting();
	});

	it('recorders are no-ops before initMetrics', () => {
		expect(() =>
			recordToolCall({
				tool: 't',
				wiki: 'w',
				outcome: 'success',
				durationMs: 1,
				upstreamStatus: undefined,
			}),
		).not.toThrow();
		expect(() => recordReadyFailure()).not.toThrow();
		expect(() => setSessionsProvider(() => 0)).not.toThrow();
	});

	it('getMetricsHandler returns undefined before init', () => {
		expect(getMetricsHandler()).toBeUndefined();
	});

	it('isMetricsEnabled reflects MCP_METRICS env', () => {
		const old = process.env.MCP_METRICS;
		process.env.MCP_METRICS = 'true';
		expect(isMetricsEnabled()).toBe(true);
		process.env.MCP_METRICS = 'false';
		expect(isMetricsEnabled()).toBe(false);
		delete process.env.MCP_METRICS;
		expect(isMetricsEnabled()).toBe(false);
		if (old !== undefined) {
			process.env.MCP_METRICS = old;
		}
	});
});

describe('metrics module — enabled state', () => {
	beforeEach(() => {
		__resetMetricsForTesting();
		initMetrics();
	});

	async function scrape(): Promise<string> {
		const handler = getMetricsHandler();
		expect(handler).toBeDefined();
		const app = express();
		app.get('/metrics', handler!);
		const res = await request(app).get('/metrics');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/plain');
		return res.text;
	}

	it('increments mcp_tool_calls_total with tool/wiki/outcome labels', async () => {
		recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 12,
			upstreamStatus: undefined,
		});
		recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 7,
			upstreamStatus: undefined,
		});
		const body = await scrape();
		expect(body).toMatch(
			/mcp_tool_calls_total\{tool="get-page",wiki="example\.org",outcome="success"\} 2/,
		);
	});

	it('observes mcp_tool_call_duration_seconds', async () => {
		recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 25,
			upstreamStatus: undefined,
		});
		const body = await scrape();
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_count{tool="get-page",wiki="example.org"} 1',
		);
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_sum{tool="get-page",wiki="example.org"} 0.025',
		);
	});

	it('increments mcp_upstream_status_total only when upstreamStatus is set', async () => {
		recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'upstream_failure',
			durationMs: 5,
			upstreamStatus: 503,
		});
		recordToolCall({
			tool: 'get-page',
			wiki: 'example.org',
			outcome: 'success',
			durationMs: 5,
			upstreamStatus: undefined,
		});
		const body = await scrape();
		expect(body).toMatch(
			/mcp_upstream_status_total\{tool="get-page",wiki="example\.org",status="503"\} 1/,
		);
		expect(body).not.toMatch(/mcp_upstream_status_total\{[^}]*status="undefined"/);
	});

	it('increments mcp_ready_failures_total', async () => {
		recordReadyFailure();
		recordReadyFailure();
		const body = await scrape();
		expect(body).toMatch(/mcp_ready_failures_total 2/);
	});

	it('mcp_active_sessions reads provider lazily at scrape', async () => {
		let count = 3;
		setSessionsProvider(() => count);
		let body = await scrape();
		expect(body).toMatch(/mcp_active_sessions 3/);
		count = 7;
		body = await scrape();
		expect(body).toMatch(/mcp_active_sessions 7/);
	});

	it('mcp_active_sessions reports 0 when no provider set', async () => {
		const body = await scrape();
		expect(body).toMatch(/mcp_active_sessions 0/);
	});

	it('initMetrics is idempotent', async () => {
		expect(() => initMetrics()).not.toThrow();
		expect(() => initMetrics()).not.toThrow();
		recordReadyFailure();
		const body = await scrape();
		expect(body).toMatch(/mcp_ready_failures_total 1/);
	});

	it('histogram exposes the documented bucket boundaries', async () => {
		recordToolCall({
			tool: 't',
			wiki: 'w',
			outcome: 'success',
			durationMs: 100,
			upstreamStatus: undefined,
		});
		const body = await scrape();
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
