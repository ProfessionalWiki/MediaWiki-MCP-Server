import { readMetrics, type Metrics } from '../../src/runtime/metrics.ts';

export function liveMetrics(): Metrics {
	return readMetrics({ MCP_METRICS: 'true' }, 'http');
}

export function metricsOff(): Metrics {
	return readMetrics({}, 'http');
}

/** The text a scrape of /metrics would return, read without going through HTTP. */
export function scrape(metrics: Metrics): Promise<string> {
	if (metrics.exposition === undefined) {
		throw new Error('scrape: these metrics are off');
	}
	return metrics.exposition.render();
}
