import type { Server as HttpServer } from 'node:http';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { emitTelemetryEvent, logger } from './logger.js';

const DEFAULT_GRACE_MS = 10_000;
const MAX_GRACE_MS = 600_000;

export function resolveShutdownGrace(env: NodeJS.ProcessEnv): number {
	const raw = env.MCP_SHUTDOWN_GRACE_MS;
	if (raw === undefined) {
		return DEFAULT_GRACE_MS;
	}
	const n = Number(raw);
	if (raw === '' || !Number.isInteger(n) || n < 0 || n > MAX_GRACE_MS) {
		logger.warning(
			`Ignoring invalid MCP_SHUTDOWN_GRACE_MS=${JSON.stringify(raw)}; ` +
				`expected an integer between 0 and ${MAX_GRACE_MS}. Using default ${DEFAULT_GRACE_MS}ms.`,
		);
		return DEFAULT_GRACE_MS;
	}
	return n;
}

export interface InFlightCounterReader {
	readonly count: () => number;
}

export type ShutdownSessionRegistry = Record<
	string,
	{
		readonly transport: Pick<StreamableHTTPServerTransport, 'close'>;
	}
>;

export type StdioCloseable = { close(): Promise<void> | void };

export interface ShutdownDeps {
	readonly transport: 'http' | 'stdio';
	readonly graceMs: number;
	readonly httpServer?: HttpServer;
	readonly sessions?: ShutdownSessionRegistry;
	readonly inFlight?: InFlightCounterReader;
	readonly stdioTransport?: StdioCloseable;
	readonly process?: NodeJS.Process;
	readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 50;

function hasCloseIdleConnections(server: unknown): server is { closeIdleConnections: () => void } {
	return (
		server !== null &&
		typeof server === 'object' &&
		'closeIdleConnections' in server &&
		typeof server.closeIdleConnections === 'function'
	);
}

export function registerShutdownHandlers(deps: ShutdownDeps): void {
	const proc = deps.process ?? process;
	let draining = false;

	const handler = (signal: 'SIGTERM' | 'SIGINT'): void => {
		if (draining) {
			proc.exit(1);
			return;
		}
		draining = true;
		runDrain(signal, deps, proc).catch(() => {
			// runDrain swallows its own errors; this catch is a belt-and-braces
			// guard so the unhandled rejection never reaches Node's default handler.
		});
	};

	proc.on('SIGTERM', () => handler('SIGTERM'));
	proc.on('SIGINT', () => handler('SIGINT'));
}

async function runDrain(
	signal: 'SIGTERM' | 'SIGINT',
	deps: ShutdownDeps,
	proc: NodeJS.Process,
): Promise<void> {
	const start = Date.now();
	const inFlightAtSignal = deps.inFlight?.count() ?? 0;
	const sessionsAtSignal = deps.sessions ? Object.keys(deps.sessions).length : 0;

	emitTelemetryEvent('info', {
		event: 'shutdown',
		signal,
		transport: deps.transport,
		grace_ms: deps.graceMs,
		in_flight_at_signal: inFlightAtSignal,
		sessions_at_signal: sessionsAtSignal,
	});

	let sessionsClosed = 0;
	if (deps.transport === 'http') {
		if (deps.httpServer) {
			// Stop accepting new connections. The close callback isn't awaited
			// because drain is gated on inFlight.count(), not on socket lifetime.
			deps.httpServer.close();
			// Node 18.2+ exposes closeIdleConnections, which lets keep-alive
			// idle sockets close so the listener can finish closing during the
			// grace window. Feature-detected so older runtimes still build.
			if (hasCloseIdleConnections(deps.httpServer)) {
				deps.httpServer.closeIdleConnections();
			}
		}
		if (deps.sessions) {
			// Snapshot the ids before iterating: transport.onclose deletes its
			// own entry from the registry, which would skip the next entry if
			// we iterated the live object directly.
			const sessionIds = Object.keys(deps.sessions);
			for (const id of sessionIds) {
				try {
					await deps.sessions[id].transport.close();
					sessionsClosed++;
				} catch {
					// Ignore: a session that fails to close cleanly should not block drain.
				}
			}
		}
	} else if (deps.stdioTransport) {
		try {
			await deps.stdioTransport.close();
		} catch {
			// Same rationale.
		}
	}

	const graceExceeded = await waitForDrain(
		deps.inFlight,
		deps.graceMs,
		deps.pollIntervalMs ?? DEFAULT_POLL_MS,
	);

	const drained = inFlightAtSignal - (deps.inFlight?.count() ?? 0);
	emitTelemetryEvent('info', {
		event: 'shutdown_complete',
		signal,
		transport: deps.transport,
		in_flight_drained: drained,
		sessions_closed: sessionsClosed,
		grace_exceeded: graceExceeded,
		duration_ms: Date.now() - start,
	});

	proc.exit(graceExceeded ? 1 : 0);
}

async function waitForDrain(
	inFlight: InFlightCounterReader | undefined,
	graceMs: number,
	pollMs: number,
): Promise<boolean> {
	if (!inFlight) {
		return false;
	}
	// "0" means no /mcp request has reached the in-flight middleware yet —
	// not "no socket activity at all". A request mid-Express-routing isn't
	// counted, but it's a sub-millisecond window that closeIdleConnections
	// handles.
	if (inFlight.count() === 0) {
		return false;
	}
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		await new Promise((r) => {
			setTimeout(r, pollMs);
		});
		if (inFlight.count() === 0) {
			return false;
		}
	}
	return inFlight.count() > 0;
}
