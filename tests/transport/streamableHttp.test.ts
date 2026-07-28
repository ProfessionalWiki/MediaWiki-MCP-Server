import { describe, it, expect, vi } from 'vitest';

import express, { type Express } from 'express';
import request from 'supertest';
import {
	createMcpHandler,
	INTERNAL_ERROR,
	McpServer,
	PARSE_ERROR,
} from '@modelcontextprotocol/server';
import {
	errorHandler,
	handleListenError,
	resolveMcpHostValidation,
	resolveMcpOriginValidation,
	toOriginHostnames,
} from '../../src/transport/streamableHttp.js';
import {
	AUTHENTICATION_REQUIRED_ERROR_CODE,
	PAYLOAD_TOO_LARGE_ERROR_CODE,
	UPSTREAM_UNAVAILABLE_ERROR_CODE,
} from '../../src/transport/errorCodes.js';
import { createMcpRouteHandler } from '../../src/transport/mcpRoute.js';
import { createInFlightCounter } from '../../src/transport/inFlight.js';
import { getRuntimeToken, withRequestContext } from '../../src/runtime/requestContext.js';
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
	function buildApp(allowedOrigins: readonly string[]): Express {
		const app = express();
		app.use(express.json());
		const guard = [resolveMcpOriginValidation(allowedOrigins)];
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

	// An empty allowlist is the non-loopback default. It must refuse the browser
	// request rather than wave it through, which is what an absent guard did.
	it('rejects any Origin when the allowlist is empty', async () => {
		const res = await post(buildApp([]), 'http://anything.example');
		expect(res.status).toBe(403);
	});

	// The spec conditions the 403 on the header being present, so every
	// non-browser client is untouched by the allowlist, empty or not.
	it.each([[['http://good.example']], [[]]])(
		'does not reject when the Origin header is absent (allowlist %j)',
		async (origins) => {
			const res = await post(buildApp(origins));
			expect(res.status).not.toBe(403);
		},
	);
});

describe('request body size cap', () => {
	function buildApp(limit: string): Express {
		const app = express();
		app.use(express.json({ limit }));
		app.use(errorHandler(limit));
		app.post('/mcp', (req, res) => {
			res.status(200).json({ ok: true, length: JSON.stringify(req.body).length });
		});
		app.post('/mcp/register', (_req, res) => {
			res.status(201).json({ ok: true });
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
		// The id is omitted, never null: this revision admits only a string or a
		// number, and body-parser aborted before any id could be read.
		expect('id' in res.body).toBe(false);
		expect(res.body?.error?.code).toBe(PAYLOAD_TOO_LARGE_ERROR_CODE);
		expect(res.body?.error?.message).toMatch(/50kb/);
	});

	it('returns an OAuth 413, not a JSON-RPC one, on an authorization-server route', async () => {
		const res = await request(buildApp('50kb'))
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send(jsonRpcEnvelope(200 * 1024));
		expect(res.status).toBe(413);
		expect(res.body?.jsonrpc).toBeUndefined();
		expect(res.body?.error).toBe('invalid_request');
		expect(res.body?.error_description).toMatch(/50kb/);
	});
});

describe('malformed JSON body', () => {
	function buildApp(): Express {
		const app = express();
		app.use(express.json());
		app.use(errorHandler('1mb'));
		app.post('/mcp', (_req, res) => {
			res.status(200).json({ ok: true });
		});
		app.post('/mcp/register', (_req, res) => {
			res.status(201).json({ ok: true });
		});
		return app;
	}

	function postBroken(path: string): request.Test {
		return request(buildApp()).post(path).set('Content-Type', 'application/json').send('{"a":');
	}

	it('returns a JSON-RPC parse error on the MCP endpoint', async () => {
		const res = await postBroken('/mcp');
		expect(res.status).toBe(400);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.body).toEqual({
			jsonrpc: '2.0',
			error: { code: PARSE_ERROR, message: 'Request body is not valid JSON' },
		});
	});

	it('returns an OAuth error, not a JSON-RPC one, on an authorization-server route', async () => {
		const res = await postBroken('/mcp/register');
		expect(res.status).toBe(400);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.body?.jsonrpc).toBeUndefined();
		expect(res.body?.error).toBe('invalid_request');
	});

	// Express routes case-insensitively by default, so these spellings reach the
	// MCP handler and must be answered in its dialect rather than OAuth's.
	it.each(['/MCP', '/Mcp', '/mcp/'])('answers %s in the JSON-RPC dialect', async (path) => {
		const res = await postBroken(path);
		expect(res.status).toBe(400);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.error?.code).toBe(PARSE_ERROR);
	});

	it('never leaks a stack trace', async () => {
		for (const path of ['/mcp', '/mcp/register']) {
			const res = await postBroken(path);
			expect(res.text).not.toMatch(/SyntaxError|at JSON\.parse/);
		}
	});
});

describe('errorHandler', () => {
	const mcpReq = { path: '/mcp' } as never;

	// Terminal: nothing may reach Express's finalhandler, which answers HTML and
	// leaks absolute paths in a stack trace outside production.
	it('answers an unrecognised error as JSON without serialising it', () => {
		const handler = errorHandler('1mb');
		const next = vi.fn();
		const json = vi.fn();
		const status = vi.fn(() => ({ json }));
		handler(new Error('boom at /home/someone/secret'), mcpReq, { status } as never, next as never);
		expect(next).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith(500);
		const body = JSON.stringify(json.mock.calls[0][0]);
		expect(body).not.toMatch(/boom|secret/);
		expect(json).toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.objectContaining({ code: INTERNAL_ERROR }) }),
		);
	});

	it('answers a non-error-shaped value without serialising it', () => {
		const handler = errorHandler('1mb');
		const next = vi.fn();
		const json = vi.fn();
		const status = vi.fn(() => ({ json }));
		handler('oops' as never, mcpReq, { status } as never, next as never);
		expect(next).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith(500);
		expect(JSON.stringify(json.mock.calls[0][0])).not.toMatch(/oops/);
	});

	it('honours an Express-supplied status', () => {
		const handler = errorHandler('1mb');
		const json = vi.fn();
		const status = vi.fn(() => ({ json }));
		const err = Object.assign(new Error('unsupported charset'), { status: 415 });
		handler(err, mcpReq, { status } as never, vi.fn() as never);
		expect(status).toHaveBeenCalledWith(415);
	});

	// Express matches `/mcp` non-strictly, so the trailing-slash form reaches the
	// MCP route and must get the MCP envelope with it.
	it('treats the trailing-slash form of the MCP path as the MCP endpoint', () => {
		const handler = errorHandler('1mb');
		const json = vi.fn();
		const res = { status: vi.fn(() => ({ json })) };
		const parseErr = Object.assign(new SyntaxError('bad'), { type: 'entity.parse.failed' });
		handler(parseErr, { path: '/mcp/' } as never, res as never, vi.fn() as never);
		expect(json).toHaveBeenCalledWith(
			expect.objectContaining({
				error: { code: PARSE_ERROR, message: 'Request body is not valid JSON' },
			}),
		);
	});
});

// MCP forbids new codes in the -32000..-32019 sub-range and directs codes for
// purposes it does not define outside the JSON-RPC reserved range altogether.
describe('transport-emitted JSON-RPC error codes', () => {
	it.each([
		['authentication required', AUTHENTICATION_REQUIRED_ERROR_CODE],
		['upstream unavailable', UPSTREAM_UNAVAILABLE_ERROR_CODE],
		['payload too large', PAYLOAD_TOO_LARGE_ERROR_CODE],
	])('%s sits outside the reserved range', (_name, code) => {
		expect(code).toBeGreaterThan(-32000);
	});

	it('allocates a distinct code per condition', () => {
		const codes = [
			AUTHENTICATION_REQUIRED_ERROR_CODE,
			UPSTREAM_UNAVAILABLE_ERROR_CODE,
			PAYLOAD_TOO_LARGE_ERROR_CODE,
		];
		expect(new Set(codes).size).toBe(codes.length);
	});
});

describe('withRequestContext', () => {
	it('propagates the bearer token into the async store', async () => {
		let observedToken: string | undefined;
		await withRequestContext('tok123', async () => {
			observedToken = getRuntimeToken();
		});
		expect(observedToken).toBe('tok123');
	});

	it('leaves the store tokenless when no bearer is supplied', async () => {
		let observedToken: string | undefined;
		await withRequestContext(undefined, async () => {
			observedToken = getRuntimeToken();
		});
		expect(observedToken).toBeUndefined();
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
