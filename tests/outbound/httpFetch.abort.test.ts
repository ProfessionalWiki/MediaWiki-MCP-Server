import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * A request cancelled before it is sent has to reject without an error escaping
 * the HTTP client and ending the process, which only the real client against a
 * real loopback server can show. Only the SSRF guard is stubbed, since a
 * loopback destination is what a local test server is.
 */
vi.mock('../../src/outbound/ssrfGuard.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/outbound/ssrfGuard.ts')>(
		'../../src/outbound/ssrfGuard.ts',
	);
	return {
		...actual,
		assertPublicDestination: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
	};
});

import { createServer, type Server } from 'node:http';
import { assertPublicDestination } from '../../src/outbound/ssrfGuard.ts';
import { makeApiRequest, postForm } from '../../src/outbound/httpFetch.ts';

let server: Server;
let origin: string;
let requestsServed = 0;

beforeAll(async () => {
	server = createServer((_req, res) => {
		requestsServed += 1;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * The errors this guards against are not thrown to the caller: they surface a
 * tick later as an unhandled 'error' event on a stream nobody is reading, which
 * Node turns into an uncaught exception. Listening for one both records it and
 * keeps this run alive to report it.
 */
async function uncaughtExceptionsDuring(run: () => Promise<void>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const record = (err: unknown): void => {
		seen.push(err);
	};
	process.on('uncaughtException', record);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 100));
	} finally {
		process.off('uncaughtException', record);
	}
	return seen;
}

describe('httpFetch against the real HTTP client', () => {
	it('posts a form body and reads the response back', async () => {
		const before = requestsServed;

		const body = await postForm(`${origin}/sparql`, { query: 'SELECT ?x WHERE {}' });

		expect(body).toBe('{"ok":true}');
		expect(requestsServed).toBe(before + 1);
	});

	it('refuses a POST whose signal is already aborted, leaving the process standing', async () => {
		const controller = new AbortController();
		controller.abort();
		const before = requestsServed;
		let failure: unknown;

		const uncaught = await uncaughtExceptionsDuring(async () => {
			failure = await postForm(
				`${origin}/sparql`,
				{ query: 'SELECT ?x WHERE {}' },
				{ signal: controller.signal },
			).catch((err: unknown) => err);
		});

		expect((failure as Error).name).toBe('AbortError');
		expect(uncaught).toEqual([]);
		expect(requestsServed).toBe(before);
	});

	it('refuses a bodiless GET whose signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const before = requestsServed;
		let failure: unknown;

		const uncaught = await uncaughtExceptionsDuring(async () => {
			failure = await makeApiRequest(`${origin}/w/api.php`, undefined, {
				signal: controller.signal,
			}).catch((err: unknown) => err);
		});

		expect((failure as Error).name).toBe('AbortError');
		expect(uncaught).toEqual([]);
		expect(requestsServed).toBe(before);
	});

	// The reachable case: resolving the destination takes tens of milliseconds,
	// once per redirect hop, and a cancellation landing inside that window is
	// already aborted by the time the request would be made.
	it('refuses a POST cancelled while the destination is being resolved', async () => {
		vi.mocked(assertPublicDestination).mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return [{ address: '127.0.0.1', family: 4 }];
		});
		const controller = new AbortController();
		const before = requestsServed;
		let failure: unknown;

		const uncaught = await uncaughtExceptionsDuring(async () => {
			const pending = postForm(
				`${origin}/sparql`,
				{ query: 'SELECT ?x WHERE {}' },
				{ signal: controller.signal },
			).catch((err: unknown) => err);
			setTimeout(() => controller.abort(), 1);
			failure = await pending;
		});

		expect((failure as Error).name).toBe('AbortError');
		expect(uncaught).toEqual([]);
		expect(requestsServed).toBe(before);
	});
});
