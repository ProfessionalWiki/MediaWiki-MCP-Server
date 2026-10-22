import { type StderrWriteSpy } from '../helpers/stderrSpy.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
	detectTruncation,
	emitToolCall,
	extractUpstreamStatus,
	hashCaller,
	levelFor,
	parseEnvelope,
	safeTarget,
} from '../../src/runtime/instrument.ts';
import { ClassifiedError } from '../../src/errors/classifyError.ts';
import { liveMetrics, metricsOff, scrape } from '../helpers/metrics.ts';

function captureToolCallLine(spy: StderrWriteSpy): Record<string, unknown> {
	const events = spy.mock.calls
		.map((c) => String(c[0]))
		.filter((s) => s.startsWith('{'))
		.map((s) => JSON.parse(s.slice(0, -1)) as Record<string, unknown>)
		.filter((e) => e.event === 'tool_call');
	expect(events.length).toBeGreaterThan(0);
	return events[events.length - 1];
}

function okResult(payload: unknown = { ok: true }): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	};
}

function errResult(category: string, message: string): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify({ category, message }) }],
		isError: true,
	};
}

describe('levelFor', () => {
	it.each([
		['success', 'info'],
		['not_found', 'warning'],
		['invalid_input', 'warning'],
		['permission_denied', 'warning'],
		['conflict', 'warning'],
		['authentication', 'warning'],
		['rate_limited', 'warning'],
		['upstream_failure', 'error'],
	])('maps %s to %s', (outcome, level) => {
		expect(levelFor(outcome as Parameters<typeof levelFor>[0])).toBe(level);
	});
});

describe('hashCaller', () => {
	it('returns "anonymous" when token is undefined', () => {
		expect(hashCaller(undefined)).toBe('anonymous');
	});

	it('returns "anonymous" when token is empty string', () => {
		expect(hashCaller('')).toBe('anonymous');
	});

	it('returns sha256:<12 hex> for a real token', () => {
		const out = hashCaller('secret-token');
		expect(out).toMatch(/^sha256:[0-9a-f]{12}$/);
	});

	it('is deterministic for the same token', () => {
		expect(hashCaller('tok')).toBe(hashCaller('tok'));
	});
});

describe('parseEnvelope', () => {
	it('returns {} for undefined', () => {
		expect(parseEnvelope(undefined)).toEqual({});
	});

	it('returns {} for empty string', () => {
		expect(parseEnvelope('')).toEqual({});
	});

	it('returns {} for non-JSON text', () => {
		expect(parseEnvelope('not json')).toEqual({});
	});

	it('returns {} for a JSON primitive', () => {
		expect(parseEnvelope('"hello"')).toEqual({});
	});

	it('returns the parsed object when text is a JSON object', () => {
		expect(parseEnvelope('{"category":"not_found","message":"missing"}')).toEqual({
			category: 'not_found',
			message: 'missing',
		});
	});
});

describe('detectTruncation', () => {
	it('returns true when structuredContent has a truncation field', () => {
		expect(detectTruncation(okResult({ source: 'partial', truncation: { reason: 'x' } }))).toBe(
			true,
		);
	});

	it('returns false when structuredContent has no truncation field', () => {
		expect(detectTruncation(okResult({ source: 'fine' }))).toBe(false);
	});

	it('returns false when there is no structuredContent', () => {
		expect(detectTruncation({ content: [] })).toBe(false);
	});
});

describe('extractUpstreamStatus', () => {
	it('returns the status when err.response.status is a number', () => {
		expect(extractUpstreamStatus({ response: { status: 429 } })).toBe(429);
	});

	it('returns undefined when err is null', () => {
		expect(extractUpstreamStatus(null)).toBeUndefined();
	});

	it('returns undefined when err has no response', () => {
		expect(extractUpstreamStatus(new Error('boom'))).toBeUndefined();
	});

	it('returns undefined when status is not a number', () => {
		expect(extractUpstreamStatus({ response: { status: '429' } })).toBeUndefined();
	});

	it('returns the status a pack recorded on the error it classified', () => {
		expect(extractUpstreamStatus(new ClassifiedError('rate_limited', 'slow down', 429))).toBe(429);
	});
});

describe('safeTarget', () => {
	it('returns "" when extractor is undefined', () => {
		expect(safeTarget(undefined, { title: 'x' })).toBe('');
	});

	it('returns the extracted value', () => {
		expect(safeTarget((a: { title: string }) => a.title, { title: 'Main Page' })).toBe('Main Page');
	});

	it('returns "" when the extractor throws', () => {
		expect(
			safeTarget(() => {
				throw new Error('oops');
			}, {}),
		).toBe('');
	});
});

describe('emitToolCall', () => {
	let stderrSpy: StderrWriteSpy;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it('emits a success line with tool, outcome, duration_ms and integer rounding', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now() - 5,
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		const line = captureToolCallLine(stderrSpy);
		expect(line.event).toBe('tool_call');
		expect(line.tool).toBe('get-page');
		expect(line.outcome).toBe('success');
		expect(line.level).toBe('info');
		expect(line.wiki).toBe('a.example');
		expect(typeof line.duration_ms).toBe('number');
		expect(Number.isInteger(line.duration_ms)).toBe(true);
	});

	it('includes target when extractor returns non-empty value', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: (a: { title: string }) => a.title,
			args: { title: 'Main Page' },
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect(captureToolCallLine(stderrSpy).target).toBe('Main Page');
	});

	it('omits target when extractor is undefined', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-pages',
			target: undefined,
			args: {},
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect('target' in captureToolCallLine(stderrSpy)).toBe(false);
	});

	it('omits target when extractor returns empty string', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: () => '',
			args: {},
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect('target' in captureToolCallLine(stderrSpy)).toBe(false);
	});

	it('omits target when extractor throws', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: () => {
				throw new Error('oops');
			},
			args: {},
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect('target' in captureToolCallLine(stderrSpy)).toBe(false);
	});

	it.each([
		['not_found', 'warning'],
		['invalid_input', 'warning'],
		['permission_denied', 'warning'],
		['conflict', 'warning'],
		['authentication', 'warning'],
		['rate_limited', 'warning'],
		['upstream_failure', 'error'],
	])('maps category %s to level %s and includes error_message', (category, level) => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now(),
			result: errResult(category, 'msg'),
			outcome: category as Parameters<typeof emitToolCall>[1]['outcome'],
			upstreamStatus: undefined,
			errorMessage: 'msg',
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		const line = captureToolCallLine(stderrSpy);
		expect(line.outcome).toBe(category);
		expect(line.level).toBe(level);
		expect(line.error_message).toBe('msg');
	});

	it('includes upstream_status when set', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now(),
			result: errResult('rate_limited', 'too many'),
			outcome: 'rate_limited',
			upstreamStatus: 429,
			errorMessage: 'too many',
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect(captureToolCallLine(stderrSpy).upstream_status).toBe(429);
	});

	it('reports truncated:true when result has truncation field', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now(),
			result: okResult({ source: 'partial', truncation: { reason: 'x' } }),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect(captureToolCallLine(stderrSpy).truncated).toBe(true);
	});

	it('reports truncated:false when result has no truncation field', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now(),
			result: okResult({ source: 'fine' }),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'a.example',
		});

		expect(captureToolCallLine(stderrSpy).truncated).toBe(false);
	});

	it('logs the caller it is given', () => {
		emitToolCall(metricsOff(), {
			toolName: 'get-page',
			target: undefined,
			args: {},
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'sha256:0123456789ab',
			wikiKey: 'a.example',
		});

		expect(captureToolCallLine(stderrSpy).caller).toBe('sha256:0123456789ab');
	});
});

describe('emitToolCall — metrics integration', () => {
	it('counts the call under its tool, wiki and outcome, with its upstream status', async () => {
		const metrics = liveMetrics();
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		emitToolCall(metrics, {
			toolName: 'get-page',
			args: { title: 'X' },
			started: performance.now() - 25,
			result: okResult(),
			outcome: 'success',
			upstreamStatus: 200,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'example.org',
		});
		stderrSpy.mockRestore();
		const body = await scrape(metrics);
		expect(body).toContain(
			'mcp_tool_calls_total{tool="get-page",wiki="example.org",outcome="success"} 1',
		);
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_count{tool="get-page",wiki="example.org"} 1',
		);
		expect(body).toContain(
			'mcp_upstream_status_total{tool="get-page",wiki="example.org",status="200"} 1',
		);
	});

	it('records no upstream status for a call that had none', async () => {
		const metrics = liveMetrics();
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		emitToolCall(metrics, {
			toolName: 'get-pages',
			args: {},
			started: performance.now(),
			result: okResult(),
			outcome: 'success',
			upstreamStatus: undefined,
			errorMessage: undefined,
			caller: 'anonymous',
			wikiKey: 'example.org',
		});
		stderrSpy.mockRestore();
		expect(await scrape(metrics)).not.toContain('mcp_upstream_status_total{');
	});
});
