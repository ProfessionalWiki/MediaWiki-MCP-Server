import { describe, it, expect, vi } from 'vitest';

import express, { type Express } from 'express';
import request from 'supertest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
	handleListenError,
	payloadTooLargeHandler,
	resolveMcpHostValidation,
	resolveMcpOriginValidation,
	toOriginHostnames,
} from '../../src/transport/streamableHttp.js';
import { createMcpRouteHandler } from '../../src/transport/mcpRoute.js';
import { createInFlightCounter } from '../../src/transport/inFlight.js';
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

describe('toOriginHostnames', () => {
	it('reduces a configured origin to its hostname', () => {
		expect(toOriginHostnames(['https://wiki.example.org'])).toEqual(['wiki.example.org']);
	});

	it('normalises the spellings that an exact-origin match used to reject', () => {
		expect(
			toOriginHostnames([
				'https://wiki.example.org/',
				'https://wiki.example.org/mcp',
				'https://wiki.example.org:443',
				'HTTPS://WIKI.EXAMPLE.ORG',
				'wiki.example.org',
				// `host:port` parses as a scheme with an opaque path, yielding an
				// empty hostname instead of throwing, so it needs the retry path.
				'wiki.example.org:8443',
			]),
		).toEqual(['wiki.example.org']);
	});

	it('keeps the brackets on an IPv6 loopback origin, with or without a scheme', () => {
		expect(toOriginHostnames(['http://[::1]:3000'])).toEqual(['[::1]']);
		expect(toOriginHostnames(['[::1]:3000'])).toEqual(['[::1]']);
		expect(toOriginHostnames(['[::1]'])).toEqual(['[::1]']);
	});

	it('reads a bare host:port for the loopback spellings an operator is likely to write', () => {
		expect(toOriginHostnames(['localhost:3000', '127.0.0.1:3000'])).toEqual([
			'localhost',
			'127.0.0.1',
		]);
	});

	// A browser sends the punycode form in the Origin header, so a Unicode entry
	// has to be folded to match rather than compared verbatim.
	it('punycodes an internationalised hostname', () => {
		expect(toOriginHostnames(['exämple.com'])).toEqual(['xn--exmple-cua.com']);
		expect(toOriginHostnames(['https://exämple.com'])).toEqual(['xn--exmple-cua.com']);
	});

	it('skips blank entries', () => {
		expect(toOriginHostnames(['', '   ', 'http://localhost:3000'])).toEqual(['localhost']);
	});

	it('drops an entry no hostname can be read from rather than adding an unmatchable one', () => {
		const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
		expect(toOriginHostnames(['https://', 'wiki.example.org'])).toEqual(['wiki.example.org']);
		expect(warn.mock.calls[0][0]).toContain('https://');
		warn.mockRestore();
	});
});

describe('origin validation (middleware)', () => {
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

	// Attaches the guard per route, as the real buildApp does. Mounting it on the
	// '/mcp' prefix instead would also cover the authorization-server routes; the
	// proxy suite covers that specifically.
	function buildApp(allowedOrigins: string[] | undefined): Express {
		const app = express();
		app.use(express.json());
		const originCheck = resolveMcpOriginValidation(allowedOrigins);
		const guard = originCheck ? [originCheck] : [];
		const handler = createMcpHandler(
			() => new McpServer({ name: 'origin-test-server', version: '0.0.0' }, { capabilities: {} }),
			{ legacy: 'stateless' },
		);
		app.post('/mcp', ...guard, createMcpRouteHandler(handler));
		return app;
	}

	function post(app: Express, origin?: string): request.Test {
		const req = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
		return origin === undefined
			? req.send(initializeBody)
			: req.set('Origin', origin).send(initializeBody);
	}

	it('returns 403 with a JSON-RPC error body when the Origin header is not in the allowlist', async () => {
		const res = await post(buildApp(['http://good.example']), 'http://evil.example');
		expect(res.status).toBe(403);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.id).toBeNull();
		expect(typeof res.body?.error?.code).toBe('number');
		expect(typeof res.body?.error?.message).toBe('string');
		expect(res.body?.error?.message).toMatch(/origin/i);
	});

	it('does not reject when the Origin header matches an allowlist entry', async () => {
		const res = await post(buildApp(['http://good.example']), 'http://good.example');
		expect(res.status).not.toBe(403);
	});

	// The match is on hostname, so a different port or scheme on an allowed host
	// passes where the previous exact-origin comparison would have rejected it.
	it('accepts another port on an allowlisted host', async () => {
		const res = await post(buildApp(['https://good.example']), 'https://good.example:8443');
		expect(res.status).not.toBe(403);
	});

	it('rejects an Origin header that cannot be parsed', async () => {
		const res = await post(buildApp(['http://good.example']), 'not-a-url');
		expect(res.status).toBe(403);
		expect(res.body?.error?.message).toMatch(/origin/i);
	});

	it('does not reject on Origin when the allowlist is undefined', async () => {
		const res = await post(buildApp(undefined), 'http://anything.example');
		expect(res.status).not.toBe(403);
	});

	it('does not reject on Origin when the header is absent', async () => {
		const res = await post(buildApp(['http://good.example']));
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

	it('does not count a subscriptions/listen POST (held-open stream must not block drain)', async () => {
		const app = express();
		app.use(express.json());
		const inFlight = createInFlightCounter();
		app.use('/mcp', inFlight.middleware);
		app.post('/mcp', (_req, res) => {
			res.json({ count: inFlight.count() });
		});

		const listen = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} });
		expect(listen.body.count).toBe(0);

		const other = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
		expect(other.body.count).toBe(1);
	});
});
