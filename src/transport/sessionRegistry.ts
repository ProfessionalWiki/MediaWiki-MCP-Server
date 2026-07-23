import type { RequestHandler } from 'express';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export type SessionEntry = {
	readonly transport: StreamableHTTPServerTransport;
	idleTimer?: ReturnType<typeof setTimeout>;
	activeRequests: number;
};

export type SessionRegistry = { [sessionId: string]: SessionEntry };

export interface InFlightCounter {
	readonly middleware: RequestHandler;
	readonly count: () => number;
}

export function createInFlightCounter(): InFlightCounter {
	let n = 0;
	const middleware: RequestHandler = (_req, res, next) => {
		n++;
		res.on('close', () => {
			n--;
		});
		next();
	};
	return { middleware, count: () => n };
}

// Marks a session as having an in-flight request or open response stream:
// increments the active-request count and cancels any pending idle expiry.
// Pair every call with markSessionIdle on the response's 'close' event.
export function markSessionActive(sessions: SessionRegistry, sessionId: string): void {
	const entry = sessions[sessionId];
	if (!entry) {
		return;
	}
	entry.activeRequests += 1;
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
}

// Marks one request/stream finished. When the session has no remaining
// in-flight requests, arms the idle-expiry timer; when it elapses the transport
// is closed and its onclose handler removes the registry entry. A timeout of 0
// disables expiry. Because this runs on response 'close', a long-lived GET SSE
// stream keeps the session active for as long as the client holds it open.
export function markSessionIdle(
	sessions: SessionRegistry,
	sessionId: string,
	idleTimeoutMs: number,
): void {
	const entry = sessions[sessionId];
	if (!entry) {
		return;
	}
	entry.activeRequests = Math.max(0, entry.activeRequests - 1);
	if (entry.activeRequests > 0 || idleTimeoutMs <= 0) {
		return;
	}
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		void sessions[sessionId]?.transport.close();
	}, idleTimeoutMs);
	entry.idleTimer.unref();
}
