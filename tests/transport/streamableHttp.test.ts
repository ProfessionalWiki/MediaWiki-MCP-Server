import { describe, it, expect, vi } from 'vitest';

import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	createMcpPostHandler,
	createSessionRequestHandler,
	extractBearerToken,
	handleListenError,
	payloadTooLargeHandler,
	resolveMcpHostValidation,
} from '../../src/transport/streamableHttp.js';
import {
	createInFlightCounter,
	markSessionActive,
	markSessionIdle,
	type SessionRegistry,
} from '../../src/transport/sessionRegistry.js';
import {
	getRuntimeToken,
	getSessionId,
	withRequestContext,
} from '../../src/runtime/requestContext.js';
import { logger } from '../../src/runtime/logger.js';

describe('handleListenError', () => {
	function listenErr(code: string): NodeJS.ErrnoException {
		return Object.assign(new Error(`${code} boom`), { code });
	}

	it('reports EADDRINUSE with the address and exits non-zero', () => {
		const onFatal = vi.fn();
		const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		handleListenError(listenErr('EADDRINUSE'), '127.0.0.1', 3000, onFatal);
		expect(spy.mock.calls[0][0]).toContain('127.0.0.1:3000');
		expect(spy.mock.calls[0][0]).toMatch(/already in use/i);
		expect(onFatal).toHaveBeenCalledWith(1);
		spy.mockRestore();
	});

	it('reports EACCES as a permission error and exits non-zero', () => {
		const onFatal = vi.fn();
		const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		handleListenError(listenErr('EACCES'), '0.0.0.0', 80, onFatal);
		expect(spy.mock.calls[0][0]).toContain('0.0.0.0:80');
		expect(spy.mock.calls[0][0]).toMatch(/permission/i);
		expect(onFatal).toHaveBeenCalledWith(1);
		spy.mockRestore();
	});

	it('reports an unexpected listen error generically and exits non-zero', () => {
		const onFatal = vi.fn();
		const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		handleListenError(listenErr('EPIPE'), '127.0.0.1', 3000, onFatal);
		expect(spy.mock.calls[0][0]).toContain('EPIPE boom');
		expect(onFatal).toHaveBeenCalledWith(1);
		spy.mockRestore();
	});
});

function req(authorization: string | undefined): Request {
	return { headers: { authorization } } as unknown as Request;
}

describe('extractBearerToken', () => {
	it('returns the token for a standard Bearer header', () => {
		expect(extractBearerToken(req('Bearer abc123'))).toBe('abc123');
	});
	it('is case-insensitive on the scheme', () => {
		expect(extractBearerToken(req('bearer abc123'))).toBe('abc123');
		expect(extractBearerToken(req('BEARER abc123'))).toBe('abc123');
	});
	it('trims whitespace around the token', () => {
		expect(extractBearerToken(req('Bearer   abc123  '))).toBe('abc123');
	});
	it('returns undefined for whitespace-only tokens', () => {
		expect(extractBearerToken(req('Bearer   \t'))).toBeUndefined();
		expect(extractBearerToken(req('Bearer '))).toBeUndefined();
	});
	it('returns undefined when header is missing', () => {
		expect(extractBearerToken(req(undefined))).toBeUndefined();
	});
	it('returns undefined for non-Bearer schemes', () => {
		expect(extractBearerToken(req('Basic xyz'))).toBeUndefined();
		expect(extractBearerToken(req('Digest xyz'))).toBeUndefined();
	});
	it('takes the first well-formed value from comma-joined duplicate headers', () => {
		expect(extractBearerToken(req('Bearer abc, Bearer def'))).toBe('abc');
	});
	it('returns undefined if the first comma-joined value is not Bearer', () => {
		expect(extractBearerToken(req(', Bearer abc'))).toBeUndefined();
		expect(extractBearerToken(req('Basic xyz, Bearer abc'))).toBeUndefined();
	});
});

describe('host validation (scoped to /mcp)', () => {
	function buildApp(host: string, allowedHosts?: string[]): Express {
		const app = express();
		app.use(express.json());
		const validation = resolveMcpHostValidation(host, allowedHosts);
		if (validation) {
			app.use('/mcp', validation);
		}
		app.post('/mcp', (_req, res) => {
			res.status(200).json({ ok: true });
		});
		app.get('/health', (_req, res) => {
			res.status(200).json({ status: 'ok' });
		});
		return app;
	}

	it('accepts localhost Host when bound to 127.0.0.1 with default allowlist', async () => {
		const res = await request(buildApp('127.0.0.1'))
			.post('/mcp')
			.set('Host', '127.0.0.1:3000')
			.send({});
		expect(res.status).toBe(200);
	});

	it('rejects non-local Host when bound to 127.0.0.1 with default allowlist', async () => {
		const res = await request(buildApp('127.0.0.1'))
			.post('/mcp')
			.set('Host', 'evil.example:3000')
			.send({});
		expect(res.status).toBe(403);
		expect(res.body?.error?.message).toMatch(/Invalid Host/);
	});

	it('accepts configured Host when explicit allowlist is set', async () => {
		const res = await request(buildApp('0.0.0.0', ['wiki.example.org']))
			.post('/mcp')
			.set('Host', 'wiki.example.org')
			.send({});
		expect(res.status).toBe(200);
	});

	it('rejects unlisted Host when explicit allowlist is set', async () => {
		const res = await request(buildApp('0.0.0.0', ['wiki.example.org']))
			.post('/mcp')
			.set('Host', 'other.example')
			.send({});
		expect(res.status).toBe(403);
		expect(res.body?.error?.message).toMatch(/Invalid Host/);
	});

	it('accepts any Host when bound to 0.0.0.0 without allowlist', async () => {
		const res = await request(buildApp('0.0.0.0'))
			.post('/mcp')
			.set('Host', 'anything.example')
			.send({});
		expect(res.status).toBe(200);
	});

	it('leaves /health reachable even when an explicit allowlist is set', async () => {
		const res = await request(buildApp('0.0.0.0', ['wiki.example.org']))
			.get('/health')
			.set('Host', 'localhost:8080');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'ok' });
	});
});

describe('session request handler (GET/DELETE)', () => {
	function buildApp(sessions: SessionRegistry): {
		app: Express;
		handleRequest: ReturnType<typeof vi.fn>;
	} {
		const app = express();
		app.use(express.json());
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
				res.status(204).end();
			},
		);
		for (const key of Object.keys(sessions)) {
			(
				sessions[key].transport as unknown as { handleRequest: typeof handleRequest }
			).handleRequest = handleRequest;
		}
		app.get('/mcp', createSessionRequestHandler(sessions));
		app.delete('/mcp', createSessionRequestHandler(sessions));
		return { app, handleRequest };
	}

	function fakeSession(): SessionRegistry {
		return {
			'sid-1': {
				transport: {} as unknown as SessionRegistry[string]['transport'],
				activeRequests: 0,
			},
		};
	}

	it('returns 400 when mcp-session-id header is missing', async () => {
		const { app } = buildApp({});
		const res = await request(app).get('/mcp');
		expect(res.status).toBe(400);
	});

	it('returns 400 when the session id is not known', async () => {
		const { app } = buildApp(fakeSession());
		const res = await request(app).get('/mcp').set('mcp-session-id', 'sid-unknown');
		expect(res.status).toBe(400);
	});

	it('forwards a GET to transport.handleRequest with a valid session id and no bearer', async () => {
		const { app, handleRequest } = buildApp(fakeSession());
		const res = await request(app).get('/mcp').set('mcp-session-id', 'sid-1');
		expect(res.status).toBe(204);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});

	it('forwards a GET regardless of which bearer it carries', async () => {
		const { app, handleRequest } = buildApp(fakeSession());
		const res = await request(app)
			.get('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer any-token');
		expect(res.status).toBe(204);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});

	it('forwards a DELETE with a valid session id and no bearer', async () => {
		const { app, handleRequest } = buildApp(fakeSession());
		const res = await request(app).delete('/mcp').set('mcp-session-id', 'sid-1');
		expect(res.status).toBe(204);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});
});

describe('POST to an existing session (per-request bearer)', () => {
	function buildApp(sessions: SessionRegistry): {
		app: Express;
		handleRequest: ReturnType<typeof vi.fn>;
	} {
		const app = express();
		app.use(express.json());
		const handleRequest = vi.fn(
			async (
				_req: unknown,
				res: { status: (n: number) => { end: () => void } },
				_body: unknown,
			) => {
				res.status(202).end();
			},
		);
		for (const key of Object.keys(sessions)) {
			(
				sessions[key].transport as unknown as { handleRequest: typeof handleRequest }
			).handleRequest = handleRequest;
		}
		app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer));
		return { app, handleRequest };
	}

	function stubCreateServer(): McpServer {
		return new McpServer({ name: 'post-test-server', version: '0.0.0' }, { capabilities: {} });
	}

	function fakeSession(): SessionRegistry {
		return {
			'sid-1': {
				transport: {} as unknown as SessionRegistry[string]['transport'],
				activeRequests: 0,
			},
		};
	}

	it('accepts a POST carrying a bearer that differs from the one that initialized the session', async () => {
		const { app, handleRequest } = buildApp(fakeSession());
		const res = await request(app)
			.post('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer a-different-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).not.toBe(401);
		expect(res.status).toBe(202);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});

	it('accepts a POST to an existing session with no bearer at all', async () => {
		const { app, handleRequest } = buildApp(fakeSession());
		const res = await request(app)
			.post('/mcp')
			.set('mcp-session-id', 'sid-1')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).not.toBe(401);
		expect(res.status).toBe(202);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});
});

describe('origin validation (transport-level)', () => {
	const initializeBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'origin-test-client', version: '0.0.0' },
		},
	};

	function stubCreateServer(): McpServer {
		return new McpServer({ name: 'origin-test-server', version: '0.0.0' }, { capabilities: {} });
	}

	function buildApp(allowedOrigins: string[] | undefined): Express {
		const app = express();
		app.use(express.json());
		const sessions: SessionRegistry = {};
		app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, { allowedOrigins }));
		return app;
	}

	it('returns 403 with a JSON-RPC error body when the Origin header is not in the allowlist', async () => {
		const res = await request(buildApp(['http://good.example']))
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.set('Origin', 'http://evil.example')
			.send(initializeBody);
		expect(res.status).toBe(403);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.id).toBeNull();
		expect(typeof res.body?.error?.code).toBe('number');
		expect(typeof res.body?.error?.message).toBe('string');
		expect(res.body?.error?.message).toMatch(/origin/i);
	});

	it('does not reject when the Origin header matches an allowlist entry', async () => {
		const res = await request(buildApp(['http://good.example']))
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.set('Origin', 'http://good.example')
			.send(initializeBody);
		expect(res.status).not.toBe(403);
	});

	it('does not reject on Origin when the allowlist is undefined', async () => {
		const res = await request(buildApp(undefined))
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.set('Origin', 'http://anything.example')
			.send(initializeBody);
		expect(res.status).not.toBe(403);
	});

	it('does not reject on Origin when the header is absent', async () => {
		const res = await request(buildApp(['http://good.example']))
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send(initializeBody);
		expect(res.status).not.toBe(403);
	});
});

describe('request body size cap', () => {
	function buildApp(limit: string): Express {
		const app = express();
		app.use(express.json({ limit }));
		app.use(payloadTooLargeHandler(limit));
		app.post('/mcp', (req, res) => {
			res.status(200).json({ ok: true, length: JSON.stringify(req.body).length });
		});
		return app;
	}

	function jsonRpcEnvelope(payloadBytes: number): Record<string, unknown> {
		return {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'update-page',
				arguments: { wikitext: 'x'.repeat(payloadBytes) },
			},
		};
	}

	it('accepts a body well under the configured cap', async () => {
		const res = await request(buildApp('200kb'))
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send(jsonRpcEnvelope(50 * 1024));
		expect(res.status).toBe(200);
		expect(res.body?.ok).toBe(true);
	});

	it('returns a JSON-RPC 413 when the body exceeds the configured cap', async () => {
		const res = await request(buildApp('50kb'))
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send(jsonRpcEnvelope(200 * 1024));
		expect(res.status).toBe(413);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.id).toBeNull();
		expect(typeof res.body?.error?.code).toBe('number');
		expect(res.body?.error?.message).toMatch(/50kb/);
	});
});

describe('payloadTooLargeHandler', () => {
	it('sends a JSON-RPC 413 when err.type is entity.too.large', () => {
		const handler = payloadTooLargeHandler('1mb');
		const next = vi.fn();
		const tooLargeErr = Object.assign(new Error('too large'), { type: 'entity.too.large' });
		const json = vi.fn();
		const status = vi.fn(() => ({ json }));
		const res = { status };
		handler(tooLargeErr, {} as never, res as never, next as never);
		expect(next).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith(413);
		expect(json).toHaveBeenCalledWith({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Request body exceeds the configured maximum size of 1mb',
			},
			id: null,
		});
	});

	it('forwards non-413 errors to the next handler', () => {
		const handler = payloadTooLargeHandler('1mb');
		const next = vi.fn();
		const otherErr = new Error('unrelated');
		const res = { status: vi.fn(), json: vi.fn() };
		handler(otherErr, {} as never, res as never, next as never);
		expect(next).toHaveBeenCalledWith(otherErr);
		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).not.toHaveBeenCalled();
	});

	it('forwards a non-error-shaped value (string) to next', () => {
		const handler = payloadTooLargeHandler('1mb');
		const next = vi.fn();
		handler('oops' as never, {} as never, {} as never, next as never);
		expect(next).toHaveBeenCalledWith('oops');
	});
});

describe('withRequestContext', () => {
	it('propagates bearer token and session id into the async store', async () => {
		let observedToken: string | undefined;
		let observedSession: string | undefined;
		await withRequestContext('tok123', 'sess123', async () => {
			observedToken = getRuntimeToken();
			observedSession = getSessionId();
		});
		expect(observedToken).toBe('tok123');
		expect(observedSession).toBe('sess123');
	});

	it('omits both when neither is supplied', async () => {
		let observedToken: string | undefined;
		let observedSession: string | undefined;
		await withRequestContext(undefined, undefined, async () => {
			observedToken = getRuntimeToken();
			observedSession = getSessionId();
		});
		expect(observedToken).toBeUndefined();
		expect(observedSession).toBeUndefined();
	});

	it('allows token without session and vice versa', async () => {
		await withRequestContext('tok-only', undefined, async () => {
			expect(getRuntimeToken()).toBe('tok-only');
			expect(getSessionId()).toBeUndefined();
		});
		await withRequestContext(undefined, 'sess-only', async () => {
			expect(getRuntimeToken()).toBeUndefined();
			expect(getSessionId()).toBe('sess-only');
		});
	});
});

describe('markSessionActive / markSessionIdle (idle expiry)', () => {
	function sessionWithCloseSpy(): {
		sessions: SessionRegistry;
		close: ReturnType<typeof vi.fn>;
	} {
		const sessions: SessionRegistry = {};
		// Mirror the real transport.close() -> onclose -> delete sessions[id] chain
		// from createMcpPostHandler, so the test exercises registry removal too.
		const transport = {
			onclose: undefined as (() => void) | undefined,
		} as unknown as SessionRegistry[string]['transport'] & { onclose?: () => void };
		const close = vi.fn(() => {
			transport.onclose?.();
			return Promise.resolve();
		});
		(transport as { close: unknown }).close = close;
		transport.onclose = () => {
			delete sessions['sid-1'];
		};
		sessions['sid-1'] = { transport, activeRequests: 0 };
		return { sessions, close };
	}

	it('does not close while a request is active (no timer armed)', () => {
		vi.useFakeTimers();
		try {
			const { sessions, close } = sessionWithCloseSpy();
			markSessionActive(sessions, 'sid-1');
			expect(sessions['sid-1'].idleTimer).toBeUndefined();
			vi.advanceTimersByTime(10_000);
			expect(close).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('arms the idle timer once the request goes idle, then closes and removes the entry', () => {
		vi.useFakeTimers();
		try {
			const { sessions, close } = sessionWithCloseSpy();
			markSessionActive(sessions, 'sid-1');
			markSessionIdle(sessions, 'sid-1', 1000);
			expect(close).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1000);
			expect(close).toHaveBeenCalledTimes(1);
			expect(sessions['sid-1']).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the session alive while at least one request is still in-flight', () => {
		vi.useFakeTimers();
		try {
			const { sessions, close } = sessionWithCloseSpy();
			// Two concurrent requests (e.g. a held-open GET SSE stream plus a POST).
			markSessionActive(sessions, 'sid-1');
			markSessionActive(sessions, 'sid-1');
			// First one finishes — still one in-flight, no timer.
			markSessionIdle(sessions, 'sid-1', 1000);
			expect(sessions['sid-1'].idleTimer).toBeUndefined();
			vi.advanceTimersByTime(5000);
			expect(close).not.toHaveBeenCalled();
			// Second one finishes — now idle, timer arms and fires.
			markSessionIdle(sessions, 'sid-1', 1000);
			vi.advanceTimersByTime(1000);
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never arms a timer when the timeout is 0 (expiry disabled)', () => {
		vi.useFakeTimers();
		try {
			const { sessions, close } = sessionWithCloseSpy();
			markSessionActive(sessions, 'sid-1');
			markSessionIdle(sessions, 'sid-1', 0);
			expect(sessions['sid-1'].idleTimer).toBeUndefined();
			vi.advanceTimersByTime(10_000_000);
			expect(close).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('is a no-op for an unknown session id', () => {
		vi.useFakeTimers();
		try {
			const { sessions } = sessionWithCloseSpy();
			expect(() => markSessionActive(sessions, 'sid-unknown')).not.toThrow();
			expect(() => markSessionIdle(sessions, 'sid-unknown', 1000)).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('idle-counter wiring through the HTTP handlers', () => {
	function stubCreateServer(): McpServer {
		return new McpServer({ name: 'idle-wiring-server', version: '0.0.0' }, { capabilities: {} });
	}

	// supertest resolves its promise on the HTTP response, but the handler's
	// markSessionIdle runs on the response's 'close' event, which can fire a
	// tick later. Mirror the createInFlightCounter abort test's setImmediate
	// drain so the post-close registry state is observable.
	async function afterResponseClosed(): Promise<void> {
		await new Promise((r) => setImmediate(r));
	}

	it('balances activeRequests back to 0 after a POST to an existing session', async () => {
		const app = express();
		app.use(express.json());
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
				res.status(202).end();
			},
		);
		// transport.sessionId must be populated: the POST handler's res.on('close')
		// reads it to route markSessionIdle back to this registry entry.
		const transport = {
			sessionId: 'sid-1',
			handleRequest,
		} as unknown as SessionRegistry[string]['transport'];
		const sessions: SessionRegistry = { 'sid-1': { transport, activeRequests: 0 } };
		app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, { idleTimeoutMs: 0 }));

		const res = await request(app)
			.post('/mcp')
			.set('mcp-session-id', 'sid-1')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		await afterResponseClosed();

		expect(res.status).toBe(202);
		// markSessionActive (+1) and the res.on('close') -> markSessionIdle (-1)
		// balanced out — the request did not leak an in-flight count.
		expect(sessions['sid-1'].activeRequests).toBe(0);
	});

	it('balances activeRequests back to 0 after a new-session initialize POST', async () => {
		const app = express();
		app.use(express.json());
		const sessions: SessionRegistry = {};
		app.post('/mcp', createMcpPostHandler(sessions, stubCreateServer, { idleTimeoutMs: 0 }));

		const res = await request(app)
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'idle-wiring-client', version: '0.0.0' },
				},
			});
		await afterResponseClosed();

		expect(res.status).toBe(200);
		const created = Object.keys(sessions);
		expect(created).toHaveLength(1);
		// onsessioninitialized seeds activeRequests: 1; the init request's
		// res.on('close') -> markSessionIdle must decrement it back to 0
		// rather than leaving the fresh session stuck at 1.
		expect(sessions[created[0]].activeRequests).toBe(0);
	});

	it('balances activeRequests back to 0 after a GET to an existing session', async () => {
		const app = express();
		app.use(express.json());
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
				res.status(204).end();
			},
		);
		const transport = {
			sessionId: 'sid-1',
			handleRequest,
		} as unknown as SessionRegistry[string]['transport'];
		const sessions: SessionRegistry = { 'sid-1': { transport, activeRequests: 0 } };
		app.get('/mcp', createSessionRequestHandler(sessions, 0));

		const res = await request(app).get('/mcp').set('mcp-session-id', 'sid-1');
		await afterResponseClosed();

		expect(res.status).toBe(204);
		// markSessionActive (+1) and res.on('close') -> markSessionIdle (-1)
		// balanced out for the GET path too.
		expect(sessions['sid-1'].activeRequests).toBe(0);
	});

	it('balances activeRequests back to 0 after a DELETE to an existing session', async () => {
		const app = express();
		app.use(express.json());
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
				res.status(204).end();
			},
		);
		const transport = {
			sessionId: 'sid-1',
			handleRequest,
		} as unknown as SessionRegistry[string]['transport'];
		const sessions: SessionRegistry = { 'sid-1': { transport, activeRequests: 0 } };
		app.delete('/mcp', createSessionRequestHandler(sessions, 0));

		const res = await request(app).delete('/mcp').set('mcp-session-id', 'sid-1');
		await afterResponseClosed();

		expect(res.status).toBe(204);
		expect(sessions['sid-1'].activeRequests).toBe(0);
	});
});

describe('createInFlightCounter', () => {
	function buildApp(): Express {
		const app = express();
		const inFlight = createInFlightCounter();
		app.use('/mcp', inFlight.middleware);
		app.post('/mcp', (_req, res) => {
			res.json({ count: inFlight.count() });
		});
		app.get('/count', (_req, res) => res.json({ count: inFlight.count() }));
		return app;
	}

	it('is 1 during the request and 0 after', async () => {
		const app = buildApp();
		const mid = await request(app).post('/mcp').send({});
		expect(mid.body.count).toBe(1);

		const after = await request(app).get('/count');
		expect(after.body.count).toBe(0);
	});

	it('decrements when the client aborts (res close without finish)', async () => {
		const app = express();
		const inFlight = createInFlightCounter();
		app.use('/mcp', inFlight.middleware);
		app.post('/mcp', (_req, res) => {
			res.destroy();
		});

		await request(app)
			.post('/mcp')
			.send({})
			.catch(() => undefined);
		await new Promise((r) => setImmediate(r));
		expect(inFlight.count()).toBe(0);
	});

	it('each factory call has its own counter', () => {
		const a = createInFlightCounter();
		const b = createInFlightCounter();
		expect(a.count).not.toBe(b.count);
	});
});
