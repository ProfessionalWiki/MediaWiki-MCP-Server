import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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

let server: Server;
let origin: string;
let openSockets: Set<Socket>;
let servingSocket: Socket;

beforeAll(async () => {
	openSockets = new Set();
	server = createServer((req, res) => {
		servingSocket = req.socket;
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
		res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
		res.write('x'.repeat(64));
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

afterAll(async () => {
	for (const socket of openSockets) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Whether the server's end of the connection goes away once the client is done with it. */
async function connectionClosed(socket: Socket, withinMs = 1000): Promise<boolean> {
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
		expect(await connectionClosed(servingSocket)).toBe(true);
	});

	it('closes the connection when the streamed body passes the cap', async () => {
		const failure = await fetchFileBytes(`${origin}/streams-too-much`, { maxBytes: 10 }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(FileTooLargeError);
		expect(await connectionClosed(servingSocket)).toBe(true);
	});

	it('closes the connection when a capped postForm refuses the body', async () => {
		const failure = await postForm(
			`${origin}/declares-too-much`,
			{ query: 'SELECT ?x WHERE {}' },
			{ maxBytes: 1024 },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(FileTooLargeError);
		expect(await connectionClosed(servingSocket)).toBe(true);
	});

	it('still returns a body that fits the cap', async () => {
		const body = await postForm(`${origin}/small`, { query: 'x' }, { maxBytes: 1024 });

		expect(body).toBe('results');
	});
});
