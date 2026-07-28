import type { RequestHandler } from 'express';
import type { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { logger } from '../runtime/logger.js';

export type SessionEntry = {
	readonly transport: NodeStreamableHTTPServerTransport;
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
		// Nothing awaits this close, and Node ends the process over a rejection
		// nothing is subscribed to. The transport calls onclose last, after every
		// stream's cleanup, so a close that fails also skips the entry removal —
		// drop it here rather than keep a session no later timer will revisit.
		sessions[sessionId]?.transport.close().catch((error: unknown) => {
			delete sessions[sessionId];
			logger.warning('Closing an idle session failed; dropped it from the registry', {
				session_id: sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, idleTimeoutMs);
	entry.idleTimer.unref();
}
