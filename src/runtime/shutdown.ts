import type { Server as HttpServer } from 'node:http';
/* eslint-disable n/no-missing-import */
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
/* eslint-enable n/no-missing-import */
import { logger } from './logger.js';

const DEFAULT_GRACE_MS = 10_000;
const MAX_GRACE_MS = 600_000;

export function resolveShutdownGrace( env: NodeJS.ProcessEnv ): number {
	const raw = env.MCP_SHUTDOWN_GRACE_MS;
	if ( raw === undefined ) {
		return DEFAULT_GRACE_MS;
	}
	const n = Number( raw );
	if ( raw === '' || !Number.isInteger( n ) || n < 0 || n > MAX_GRACE_MS ) {
		logger.warning(
			`Ignoring invalid MCP_SHUTDOWN_GRACE_MS=${ JSON.stringify( raw ) }; ` +
			`expected an integer between 0 and ${ MAX_GRACE_MS }. Using default ${ DEFAULT_GRACE_MS }ms.`
		);
		return DEFAULT_GRACE_MS;
	}
	return n;
}

export interface InFlightCounterReader {
	readonly count: () => number;
}

export type ShutdownSessionRegistry = Record<string, {
	readonly transport: Pick<StreamableHTTPServerTransport, 'close'>;
}>;

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

export function registerShutdownHandlers( deps: ShutdownDeps ): void {
	const proc = deps.process ?? process;
	let draining = false;

	const handler = ( signal: 'SIGTERM' | 'SIGINT' ): void => {
		if ( draining ) {
			proc.exit( 1 );
			return;
		}
		draining = true;
		runDrain( signal, deps, proc ).catch( () => {
			// runDrain swallows its own errors; this catch is a belt-and-braces
			// guard so the unhandled rejection never reaches Node's default handler.
		} );
	};

	proc.on( 'SIGTERM', () => handler( 'SIGTERM' ) );
	proc.on( 'SIGINT', () => handler( 'SIGINT' ) );
}

async function runDrain(
	signal: 'SIGTERM' | 'SIGINT',
	deps: ShutdownDeps,
	proc: NodeJS.Process
): Promise<void> {
	const start = Date.now();
	const inFlightAtSignal = deps.inFlight?.count() ?? 0;
	const sessionsAtSignal = deps.sessions ? Object.keys( deps.sessions ).length : 0;

	logger.info( '', {
		event: 'shutdown',
		signal,
		transport: deps.transport,
		// eslint-disable-next-line camelcase
		grace_ms: deps.graceMs,
		// eslint-disable-next-line camelcase
		in_flight_at_signal: inFlightAtSignal,
		// eslint-disable-next-line camelcase
		sessions_at_signal: sessionsAtSignal
	} );

	let sessionsClosed = 0;
	if ( deps.transport === 'http' ) {
		if ( deps.httpServer ) {
			deps.httpServer.close();
			const idleCloser = (
				deps.httpServer as unknown as { closeIdleConnections?: () => void }
			).closeIdleConnections;
			if ( typeof idleCloser === 'function' ) {
				idleCloser.call( deps.httpServer );
			}
		}
		if ( deps.sessions ) {
			for ( const id of Object.keys( deps.sessions ) ) {
				try {
					await deps.sessions[ id ].transport.close();
					sessionsClosed++;
				} catch {
					// Ignore: a session that fails to close cleanly should not block drain.
				}
			}
		}
	} else if ( deps.stdioTransport ) {
		try {
			await deps.stdioTransport.close();
		} catch {
			// Same rationale.
		}
	}

	const graceExceeded = await waitForDrain(
		deps.inFlight,
		deps.graceMs,
		deps.pollIntervalMs ?? DEFAULT_POLL_MS
	);

	const drained = inFlightAtSignal - ( deps.inFlight?.count() ?? 0 );
	logger.info( '', {
		event: 'shutdown_complete',
		signal,
		transport: deps.transport,
		// eslint-disable-next-line camelcase
		in_flight_drained: drained,
		// eslint-disable-next-line camelcase
		sessions_closed: sessionsClosed,
		// eslint-disable-next-line camelcase
		grace_exceeded: graceExceeded,
		// eslint-disable-next-line camelcase
		duration_ms: Date.now() - start
	} );

	proc.exit( graceExceeded ? 1 : 0 );
}

async function waitForDrain(
	inFlight: InFlightCounterReader | undefined,
	graceMs: number,
	pollMs: number
): Promise<boolean> {
	if ( !inFlight ) {
		return false;
	}
	if ( inFlight.count() === 0 ) {
		return false;
	}
	const deadline = Date.now() + graceMs;
	while ( Date.now() < deadline ) {
		await new Promise( ( r ) => {
			setTimeout( r, pollMs );
		} );
		if ( inFlight.count() === 0 ) {
			return false;
		}
	}
	return inFlight.count() > 0;
}
