import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * What an over-cap refusal does to the connection is only visible against a
 * real server: the rest of the httpFetch suite mocks node-fetch wholesale, so
 * it never sees a socket. node-fetch holds the connection until the response
 * body is consumed or destroyed, so a refusal that leaves the body untouched
 * strands the socket. Only the SSRF guard is stubbed, since a loopback
 * destination is what a local test server is.
 */
vi.mock('../../src/transport/ssrfGuard.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/ssrfGuard.ts')>(
		'../../src/transport/ssrfGuard.ts',
	);
	return {
		...actual,
		assertPublicDestination: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
		buildPinnedAgent: vi.fn(() => undefined),
	};
});

import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { fetchFileBytes, postForm, FileTooLargeError } from '../../src/transport/httpFetch.ts';
import { RedirectDropsBodyError } from '../../src/transport/requestChain.ts';

let server: Server;
let origin: string;
let openSockets: Set<Socket>;
let servedSockets: Socket[] = [];

beforeAll(async () => {
	openSockets = new Set();
	server = createServer((req, res) => {
		servedSockets.push(req.socket);
		if (req.url === '/small') {
			res.writeHead(200, { 'Content-Length': '7' });
			res.end('results');
			return;
		}
		// The over-cap routes send their headers and then stall, never ending the
		// response. A client that drops such a body without destroying it holds
		// the socket open for as long as it lives, which is what these tests
		// measure; one that completes normally would return the socket to the
		// keep-alive pool and hide the difference.
		if (req.url === '/declares-too-much') {
			res.writeHead(200, { 'Content-Length': String(50 * 1024 * 1024) });
			res.write('x');
			return;
		}
		if (req.url === '/streams-too-much') {
			res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
			res.write('x'.repeat(64));
			return;
		}
		// A stalling body on a redirect that is refused.
		if (req.url === '/redirect-and-stall') {
			res.writeHead(301, {
				Location: '/small',
				'Content-Length': String(50 * 1024 * 1024),
			});
			res.write('x');
			return;
		}
		// The same, on a redirect that is followed.
		if (req.url === '/followed-and-stall') {
			res.writeHead(307, {
				Location: '/small',
				'Content-Length': String(50 * 1024 * 1024),
			});
			res.write('x');
			return;
		}
		// Anything else is a test asking for a route that does not exist. Refusing
		// it keeps a mistyped path from quietly getting a different route's answer.
		res.writeHead(404);
		res.end();
	});
	// A client destroying its socket reaches the server as a reset.
	server.on('connection', (socket) => {
		openSockets.add(socket);
		socket.on('error', () => {});
		socket.on('close', () => openSockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

beforeEach(() => {
	servedSockets = [];
});

afterAll(async () => {
	for (const socket of openSockets) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Whether every connection the server served goes away. An empty list means no
 * request reached it, so there is nothing to observe: say so rather than pass.
 */
async function connectionsClosed(sockets: Socket[], withinMs = 1000): Promise<boolean> {
	if (sockets.length === 0) {
		throw new Error('The server served no request, so no connection was observed.');
	}
	const closed = await Promise.all(sockets.map((socket) => connectionClosed(socket, withinMs)));
	return closed.every(Boolean);
}

async function connectionClosed(socket: Socket, withinMs: number): Promise<boolean> {
	if (socket.destroyed) {
		return true;
	}
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), withinMs);
		socket.once('close', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

describe('an over-cap body refused against a real server', () => {
	it('closes the connection when the declared content-length is over the cap', async () => {
		const failure = await fetchFileBytes(`${origin}/declares-too-much`, {
			maxBytes: 1024,
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FileTooLargeError);
		expect(await connectionsClosed(servedSockets)).toBe(true);
	});

	it('closes the connection when the streamed body passes the cap', async () => {
		const failure = await fetchFileBytes(`${origin}/streams-too-much`, { maxBytes: 10 }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(FileTooLargeError);
		expect(await connectionsClosed(servedSockets)).toBe(true);
	});

	// The followed hop's own body is never read, so only the driver releases it.
	it('closes the connection behind a redirect it follows', async () => {
		const body = await postForm(`${origin}/followed-and-stall`, {
			query: 'SELECT ?x WHERE {}',
		});

		expect(body).toBe('results');
		expect(servedSockets).toHaveLength(2);
		// The final response is read to completion and this file stubs the pinned
		// agent away, so its socket is pooled rather than closed, by design.
		expect(await connectionsClosed(servedSockets.slice(0, 1))).toBe(true);
	});

	it('closes the connection behind a redirect it refuses to follow', async () => {
		const failure = await postForm(`${origin}/redirect-and-stall`, {
			query: 'SELECT ?x WHERE {}',
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RedirectDropsBodyError);
		expect(await connectionsClosed(servedSockets)).toBe(true);
	});

	it('closes the connection when a capped postForm refuses the body', async () => {
		const failure = await postForm(
			`${origin}/declares-too-much`,
			{ query: 'SELECT ?x WHERE {}' },
			{ maxBytes: 1024 },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FileTooLargeError);
		expect(await connectionsClosed(servedSockets)).toBe(true);
	});

	it('still returns a body that fits the cap', async () => {
		const body = await postForm(`${origin}/small`, { query: 'x' }, { maxBytes: 1024 });

		expect(body).toBe('results');
	});
});
