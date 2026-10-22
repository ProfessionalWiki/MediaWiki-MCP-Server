import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ToolOutcome } from './instrument.ts';
import type { Transport } from './authShape.ts';

export interface RecordToolCallInput {
	readonly tool: string;
	readonly wiki: string;
	readonly outcome: ToolOutcome;
	readonly durationMs: number;
	readonly upstreamStatus: number | undefined;
}

// Structural shape of the proxy-store size snapshot the gauges read on scrape.
// Defined locally so runtime/ keeps no dependency on auth/; it matches
// InMemoryProxyStore.stats() by structure at the wiring site.
type ProxyStoreStats = { readonly upstreamTokens: number; readonly clients: number };

export interface Exposition {
	readonly contentType: string;
	render(): Promise<string>;
}

export interface Metrics {
	recordToolCall(input: RecordToolCallInput): void;
	recordReadyFailure(): void;
	recordRateLimited(caller: 'caller' | 'anonymous'): void;
	setInFlightProvider(fn: () => number): void;
	setSubscriptionStreamsProvider(fn: () => number): void;
	recordStoreFlush(durationMs: number): void;
	recordStoreFlushFailure(): void;
	setProxyStoreStatsProvider(fn: () => ProxyStoreStats): void;
	/** What /metrics serves; undefined when metrics are off, so the route is not mounted. */
	readonly exposition: Exposition | undefined;
}

const DURATION_BUCKETS_SECONDS: readonly number[] = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// A proxy-store flush is a synchronous serialize + AES-GCM encrypt + file write:
// sub-millisecond for a small store, rising toward tens of ms as the durable slice
// grows. Buckets start finer and below the tool-call set to resolve that range.
const FLUSH_BUCKETS_SECONDS: readonly number[] = [
	0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
];

function createDisabledMetrics(): Metrics {
	return {
		recordToolCall: () => {},
		recordReadyFailure: () => {},
		recordRateLimited: () => {},
		setInFlightProvider: () => {},
		setSubscriptionStreamsProvider: () => {},
		recordStoreFlush: () => {},
		recordStoreFlushFailure: () => {},
		setProxyStoreStatsProvider: () => {},
		exposition: undefined,
	};
}

function createLiveMetrics(): Metrics {
	const registry = new Registry();
	let inFlightProvider: (() => number) | undefined;
	let subscriptionStreamsProvider: (() => number) | undefined;
	let storeStatsProvider: (() => ProxyStoreStats) | undefined;

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

	const rateLimited = new Counter({
		name: 'mcp_rate_limited_total',
		help: 'Total tools/call requests refused with 429, labelled by whether the caller was authenticated.',
		labelNames: ['caller'] as const,
		registers: [registry],
	});

	new Gauge({
		name: 'mcp_inflight_requests',
		help: 'Number of requests under /mcp currently being served (subscription streams excluded).',
		registers: [registry],
		collect() {
			this.set(inFlightProvider ? inFlightProvider() : 0);
		},
	});

	new Gauge({
		name: 'mcp_subscription_streams',
		help: 'Number of open subscriptions/listen streams.',
		registers: [registry],
		collect() {
			this.set(subscriptionStreamsProvider ? subscriptionStreamsProvider() : 0);
		},
	});

	const storeFlushDuration = new Histogram({
		name: 'mcp_proxy_store_flush_duration_seconds',
		help: 'Duration of a hosted OAuth proxy store durable flush (serialize + encrypt + write) in seconds.',
		buckets: [...FLUSH_BUCKETS_SECONDS],
		registers: [registry],
	});

	const storeFlushFailures = new Counter({
		name: 'mcp_proxy_store_flush_failures_total',
		help: 'Total number of hosted OAuth proxy store durable flushes that failed to write.',
		registers: [registry],
	});

	new Gauge({
		name: 'mcp_proxy_store_upstream_tokens',
		help: 'Number of upstream MediaWiki tokens held in the hosted OAuth proxy store.',
		registers: [registry],
		collect() {
			this.set(storeStatsProvider ? storeStatsProvider().upstreamTokens : 0);
		},
	});

	new Gauge({
		name: 'mcp_proxy_store_clients',
		help: 'Number of registered clients held in the hosted OAuth proxy store.',
		registers: [registry],
		collect() {
			this.set(storeStatsProvider ? storeStatsProvider().clients : 0);
		},
	});

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
		recordRateLimited(caller) {
			rateLimited.inc({ caller });
		},
		setInFlightProvider(fn) {
			inFlightProvider = fn;
		},
		setSubscriptionStreamsProvider(fn) {
			subscriptionStreamsProvider = fn;
		},
		recordStoreFlush(durationMs) {
			storeFlushDuration.observe(durationMs / 1000);
		},
		recordStoreFlushFailure() {
			storeFlushFailures.inc();
		},
		setProxyStoreStatsProvider(fn) {
			storeStatsProvider = fn;
		},
		exposition: {
			contentType: registry.contentType,
			render: () => registry.metrics(),
		},
	};
}

export function readMetrics(env: NodeJS.ProcessEnv, transport: Transport): Metrics {
	return transport === 'http' && env.MCP_METRICS === 'true'
		? createLiveMetrics()
		: createDisabledMetrics();
}
