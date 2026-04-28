import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ToolOutcome } from './instrument.js';

export interface RecordToolCallInput {
	readonly tool: string;
	readonly wiki: string;
	readonly outcome: ToolOutcome;
	readonly durationMs: number;
	readonly upstreamStatus: number | undefined;
}

interface Recorder {
	recordToolCall(input: RecordToolCallInput): void;
	recordReadyFailure(): void;
	setSessionsProvider(fn: () => number): void;
	getMetricsHandler(): RequestHandler | undefined;
}

const DURATION_BUCKETS_SECONDS: readonly number[] = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function makeDisabledRecorder(): Recorder {
	return {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		recordToolCall: () => {},
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		recordReadyFailure: () => {},
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		setSessionsProvider: () => {},
		getMetricsHandler: () => undefined,
	};
}

function makeLiveRecorder(): Recorder {
	const registry = new Registry();
	let sessionsProvider: (() => number) | undefined;

	const toolCalls = new Counter({
		name: 'mcp_tool_calls_total',
		help: 'Total number of MCP tool invocations, labelled by tool, wiki, and outcome.',
		labelNames: ['tool', 'wiki', 'outcome'] as const,
		registers: [registry],
	});

	const toolCallDuration = new Histogram({
		name: 'mcp_tool_call_duration_seconds',
		help: 'Tool-call duration in seconds, labelled by tool and wiki.',
		labelNames: ['tool', 'wiki'] as const,
		buckets: [...DURATION_BUCKETS_SECONDS],
		registers: [registry],
	});

	const upstreamStatus = new Counter({
		name: 'mcp_upstream_status_total',
		help: 'Upstream MediaWiki HTTP status codes observed, labelled by tool, wiki, and status.',
		labelNames: ['tool', 'wiki', 'status'] as const,
		registers: [registry],
	});

	const readyFailures = new Counter({
		name: 'mcp_ready_failures_total',
		help: 'Total number of /ready probes that returned a non-200 status.',
		registers: [registry],
	});

	// eslint-disable-next-line no-new
	new Gauge({
		name: 'mcp_active_sessions',
		help: 'Number of active StreamableHTTP MCP sessions.',
		registers: [registry],
		collect() {
			this.set(sessionsProvider ? sessionsProvider() : 0);
		},
	});

	const handler: RequestHandler = async (_req, res) => {
		res.set('Content-Type', registry.contentType);
		res.status(200).send(await registry.metrics());
	};

	return {
		recordToolCall(input) {
			toolCalls.inc({ tool: input.tool, wiki: input.wiki, outcome: input.outcome });
			toolCallDuration.observe({ tool: input.tool, wiki: input.wiki }, input.durationMs / 1000);
			if (input.upstreamStatus !== undefined) {
				upstreamStatus.inc({
					tool: input.tool,
					wiki: input.wiki,
					status: String(input.upstreamStatus),
				});
			}
		},
		recordReadyFailure() {
			readyFailures.inc();
		},
		setSessionsProvider(fn) {
			sessionsProvider = fn;
		},
		getMetricsHandler() {
			return handler;
		},
	};
}

let recorder: Recorder = makeDisabledRecorder();
let initialized = false;

export function isMetricsEnabled(): boolean {
	return process.env.MCP_METRICS === 'true';
}

export function initMetrics(): void {
	if (initialized) {
		return;
	}
	initialized = true;
	recorder = makeLiveRecorder();
}

export function recordToolCall(input: RecordToolCallInput): void {
	recorder.recordToolCall(input);
}

export function recordReadyFailure(): void {
	recorder.recordReadyFailure();
}

export function setSessionsProvider(fn: () => number): void {
	recorder.setSessionsProvider(fn);
}

export function getMetricsHandler(): RequestHandler | undefined {
	return recorder.getMetricsHandler();
}

// Test-only seam: returns the module to its disabled state so tests can re-init
// without prom-client throwing on duplicate metric registration.
// eslint-disable-next-line no-underscore-dangle
export function __resetMetricsForTesting(): void {
	initialized = false;
	recorder = makeDisabledRecorder();
}
