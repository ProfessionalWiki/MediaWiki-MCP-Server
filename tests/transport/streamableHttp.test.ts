import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/loadConfig.js', () => ({
	loadConfigFromFile: () => ({
		defaultWiki: 'test',
		wikis: {
			test: {
				sitename: 'Test',
				server: 'https://test.example',
				articlepath: '/wiki',
				scriptpath: '/w',
				token: null,
				username: null,
				password: null,
			},
		},
		uploadDirs: [],
	}),
}));

vi.mock('../../src/wikis/mwnProvider.js', () => ({
	MwnProviderImpl: class {
		get = () => Promise.reject(new Error('mwn not available in tests'));
		invalidate = () => {};
	},
}));

import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	createInFlightCounter,
	createMcpPostHandler,
	createSessionRequestHandler,
	extractBearerToken,
	hashBearer,
	payloadTooLargeHandler,
	resolveMcpHostValidation,
	type SessionRegistry,
	verifySessionBearer,
	withRequestContext,
} from '../../src/transport/streamableHttp.js';
import { getRuntimeToken, getSessionId } from '../../src/transport/requestContext.js';

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

describe('hashBearer', () => {
	it('returns a 64-character hex string', () => {
		expect(hashBearer('abc123')).toMatch(/^[0-9a-f]{64}$/);
	});
	it('is deterministic for the same token', () => {
		expect(hashBearer('abc123')).toBe(hashBearer('abc123'));
	});
	it('produces different hashes for different tokens', () => {
		expect(hashBearer('abc123')).not.toBe(hashBearer('xyz789'));
	});
	it('produces a distinct hash for undefined vs a present token', () => {
		expect(hashBearer(undefined)).not.toBe(hashBearer(''));
		expect(hashBearer(undefined)).not.toBe(hashBearer('abc'));
	});
	it('is deterministic for undefined', () => {
		expect(hashBearer(undefined)).toBe(hashBearer(undefined));
	});
});

describe('verifySessionBearer', () => {
	it('returns true when the presented token matches the hashed original', () => {
		expect(verifySessionBearer(hashBearer('abc123'), 'abc123')).toBe(true);
	});
	it('returns false when the presented token differs from the hashed original', () => {
		expect(verifySessionBearer(hashBearer('abc123'), 'xyz789')).toBe(false);
	});
	it('returns false when the hash was of a token and the request has none', () => {
		expect(verifySessionBearer(hashBearer('abc123'), undefined)).toBe(false);
	});
	it('returns false when the hash was of no token and the request has one', () => {
		expect(verifySessionBearer(hashBearer(undefined), 'abc123')).toBe(false);
	});
	it('returns true when both original and presented are absent', () => {
		expect(verifySessionBearer(hashBearer(undefined), undefined)).toBe(true);
	});
	it('returns false for a malformed stored hash without throwing', () => {
		expect(() => verifySessionBearer('not-a-hash', 'abc123')).not.toThrow();
		expect(verifySessionBearer('not-a-hash', 'abc123')).toBe(false);
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

describe('session-bearer binding (GET/DELETE handler)', () => {
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

	function fakeSession(bearerHash: string): SessionRegistry {
		return {
			'sid-1': {
				transport: {} as unknown as SessionRegistry[string]['transport'],
				bearerHash,
			},
		};
	}

	it('returns 400 when mcp-session-id header is missing', async () => {
		const { app } = buildApp({});
		const res = await request(app).get('/mcp');
		expect(res.status).toBe(400);
	});

	it('returns 400 when the session id is not known', async () => {
		const { app } = buildApp(fakeSession(hashBearer('abc')));
		const res = await request(app).get('/mcp').set('mcp-session-id', 'sid-unknown');
		expect(res.status).toBe(400);
	});

	it('forwards to transport.handleRequest when bearer matches the bound session', async () => {
		const sessions = fakeSession(hashBearer('abc'));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app)
			.get('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer abc');
		expect(res.status).toBe(204);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});

	it('returns 401 with a JSON-RPC error when the bearer differs from the bound session', async () => {
		const sessions = fakeSession(hashBearer('abc'));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app)
			.get('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer different');
		expect(res.status).toBe(401);
		expect(res.body?.error?.message).toMatch(/session/i);
		expect(handleRequest).not.toHaveBeenCalled();
	});

	it('returns 401 when the session was bound with a bearer but the request has none', async () => {
		const sessions = fakeSession(hashBearer('abc'));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app).get('/mcp').set('mcp-session-id', 'sid-1');
		expect(res.status).toBe(401);
		expect(handleRequest).not.toHaveBeenCalled();
	});

	it('returns 401 when the session was bound without a bearer but the request now supplies one', async () => {
		const sessions = fakeSession(hashBearer(undefined));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app)
			.get('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer abc');
		expect(res.status).toBe(401);
		expect(handleRequest).not.toHaveBeenCalled();
	});

	it('forwards a DELETE when bearer matches the bound session', async () => {
		const sessions = fakeSession(hashBearer('abc'));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app)
			.delete('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer abc');
		expect(res.status).toBe(204);
		expect(handleRequest).toHaveBeenCalledTimes(1);
	});

	it('rejects a DELETE with a mismatched bearer', async () => {
		const sessions = fakeSession(hashBearer('abc'));
		const { app, handleRequest } = buildApp(sessions);
		const res = await request(app)
			.delete('/mcp')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', 'Bearer nope');
		expect(res.status).toBe(401);
		expect(handleRequest).not.toHaveBeenCalled();
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
