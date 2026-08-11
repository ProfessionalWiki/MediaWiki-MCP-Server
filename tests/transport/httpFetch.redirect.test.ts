import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * What a redirect target actually receives is the subject here, so this file
 * runs the REAL node-fetch against a real loopback server that records the
 * method, body and headers of every request it serves. Only the SSRF guard is
 * stubbed, since a loopback destination is what a local test server is.
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

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { makeApiRequest, postForm } from '../../src/transport/httpFetch.ts';

type ServedRequest = {
	method: string;
	url: string;
	body: string;
	headers: IncomingHttpHeaders;
};

const FORM = { query: 'SELECT ?x WHERE {}' };
const ENCODED_FORM = 'query=SELECT+%3Fx+WHERE+%7B%7D';

let server: Server;
let origin: string;
let served: ServedRequest[] = [];

/**
 * `/redirect/<status>/<rest>` answers with that status and `Location: /<rest>`,
 * so `/redirect/302/redirect/307/sparql` is a two-hop chain. Any other path is
 * a target and answers 200.
 */
beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			served.push({
				method: req.method ?? '',
				url: req.url ?? '',
				body: Buffer.concat(chunks).toString('utf8'),
				headers: req.headers,
			});
			const hop = /^\/redirect\/(\d{3})\/(.+)$/.exec(req.url ?? '');
			if (hop) {
				res.writeHead(Number(hop[1]), { Location: `/${hop[2]}` });
				res.end('redirect notice');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"ok":true}');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	served = [];
});

function methodsAndBodies(): { method: string; body: string }[] {
	return served.map(({ method, body }) => ({ method, body }));
}

function target(): ServedRequest {
	return served[served.length - 1];
}

describe('redirected requests', () => {
	it.each([301, 302, 303])(
		'sends a bodyless GET to the target of a %i redirect',
		async (status) => {
			const result = await postForm(`${origin}/redirect/${status}/sparql`, FORM);

			expect(result).toBe('{"ok":true}');
			expect(methodsAndBodies()).toEqual([
				{ method: 'POST', body: ENCODED_FORM },
				{ method: 'GET', body: '' },
			]);
		},
	);

	it.each([307, 308])(
		're-sends the POST and its body to the target of a %i redirect',
		async (status) => {
			const result = await postForm(`${origin}/redirect/${status}/sparql`, FORM);

			expect(result).toBe('{"ok":true}');
			expect(methodsAndBodies()).toEqual([
				{ method: 'POST', body: ENCODED_FORM },
				{ method: 'POST', body: ENCODED_FORM },
			]);
		},
	);

	it('stops describing a body the downgraded request no longer carries', async () => {
		await postForm(`${origin}/redirect/303/sparql`, FORM);

		expect(target().headers['content-type']).toBeUndefined();
		expect(target().headers['content-length']).toBeUndefined();
	});

	it("drops the caller's other body-describing headers across a downgrade", async () => {
		await postForm(`${origin}/redirect/303/sparql`, FORM, {
			headers: {
				'Content-Encoding': 'identity',
				'Content-Language': 'en',
				// node-fetch recomputes Content-Length only for a request that has
				// a body, so a caller's value reaches the downgraded GET unless the
				// downgrade removes it.
				'Content-Length': '25',
				'Content-Location': '/sparql',
			},
		});

		expect(target().headers['content-encoding']).toBeUndefined();
		expect(target().headers['content-language']).toBeUndefined();
		expect(target().headers['content-length']).toBeUndefined();
		expect(target().headers['content-location']).toBeUndefined();
	});

	it('keeps the form content type on a hop that still sends the body', async () => {
		await postForm(`${origin}/redirect/307/sparql`, FORM);

		expect(target().headers['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('keeps a caller header unrelated to the body across a downgrade', async () => {
		await postForm(`${origin}/redirect/303/sparql`, FORM, {
			headers: { Accept: 'application/sparql-results+json' },
		});

		expect(target().headers.accept).toBe('application/sparql-results+json');
	});

	it('does not resurrect the body when a later hop preserves the method', async () => {
		await postForm(`${origin}/redirect/302/redirect/307/sparql`, FORM);

		expect(methodsAndBodies()).toEqual([
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'GET', body: '' },
			{ method: 'GET', body: '' },
		]);
	});

	it('downgrades a preserved POST at the hop that asks for it', async () => {
		await postForm(`${origin}/redirect/307/redirect/302/sparql`, FORM);

		expect(methodsAndBodies()).toEqual([
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'GET', body: '' },
		]);
	});

	it('leaves a redirected GET a GET, query string and all', async () => {
		const result = await makeApiRequest<{ ok: boolean }>(`${origin}/redirect/301/w/api.php`, {
			action: 'query',
		});

		expect(result).toEqual({ ok: true });
		expect(methodsAndBodies()).toEqual([
			{ method: 'GET', body: '' },
			{ method: 'GET', body: '' },
		]);
		expect(target().url).toBe('/w/api.php?action=query');
	});
});
