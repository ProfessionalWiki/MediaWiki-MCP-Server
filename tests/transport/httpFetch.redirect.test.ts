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
import {
	makeApiRequest,
	postForm,
	HttpStatusError,
	RedirectDropsBodyError,
} from '../../src/transport/httpFetch.ts';

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
			// A 3xx with no Location at all, which is not a redirect to follow.
			if (req.url === '/locationless') {
				res.writeHead(302);
				res.end('going nowhere');
				return;
			}
			// A target carrying a credential, which a query-service URL can do and
			// the refusal must keep out of its message.
			if (req.url === '/redirect-to-token') {
				res.writeHead(301, { Location: '/sparql?token=hunter2' });
				res.end('redirect notice');
				return;
			}
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

async function refusalFrom(url: string): Promise<RedirectDropsBodyError> {
	const error = await postForm(url, FORM).catch((err: unknown) => err);
	expect(error).toBeInstanceOf(RedirectDropsBodyError);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pinned by the assertion above
	return error as RedirectDropsBodyError;
}

describe('redirected requests', () => {
	it.each([301, 302, 303])(
		'refuses a %i redirect of a request that carries a body',
		async (status) => {
			const error = await refusalFrom(`${origin}/redirect/${status}/sparql`);

			expect(error.status).toBe(status);
			// The first hop went out whole; the target was never contacted, so the
			// refusal is not a request that quietly lost what it was carrying.
			expect(methodsAndBodies()).toEqual([{ method: 'POST', body: ENCODED_FORM }]);
		},
	);

	it('names the redirect target it refused to follow, resolved absolutely', async () => {
		const error = await refusalFrom(`${origin}/redirect/301/sparql`);

		expect(error.target).toBe(`${origin}/sparql`);
	});

	it('keeps the refused target out of the message, which reaches the caller and the logs', async () => {
		const error = await refusalFrom(`${origin}/redirect-to-token`);

		expect(error.target).toBe(`${origin}/sparql?token=hunter2`);
		expect(error.message).not.toContain('hunter2');
		expect(error.message).not.toContain(origin);
		expect(error.message).toContain('301');
	});

	it('reports a 3xx carrying no Location as the status it is, not as a refusal', async () => {
		const error = await postForm(`${origin}/locationless`, FORM).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(HttpStatusError);
		expect(error).not.toBeInstanceOf(RedirectDropsBodyError);
	});

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

	it('re-sends the body across a chain of preserving hops', async () => {
		const result = await postForm(`${origin}/redirect/307/redirect/308/sparql`, FORM);

		expect(result).toBe('{"ok":true}');
		expect(methodsAndBodies()).toEqual([
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'POST', body: ENCODED_FORM },
		]);
	});

	it('refuses at the hop that would drop the body, after the earlier hops were re-sent', async () => {
		const error = await refusalFrom(`${origin}/redirect/307/redirect/302/sparql`);

		expect(error.status).toBe(302);
		expect(error.target).toBe(`${origin}/sparql`);
		expect(methodsAndBodies()).toEqual([
			{ method: 'POST', body: ENCODED_FORM },
			{ method: 'POST', body: ENCODED_FORM },
		]);
	});

	it('keeps the form content type on a hop that still sends the body', async () => {
		await postForm(`${origin}/redirect/307/sparql`, FORM);

		expect(target().headers['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('keeps a caller header on a hop that re-sends the body', async () => {
		await postForm(`${origin}/redirect/307/sparql`, FORM, {
			headers: { Accept: 'application/sparql-results+json' },
		});

		expect(target().headers.accept).toBe('application/sparql-results+json');
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

	it('follows a multi-hop redirect of a bodyless request to the target', async () => {
		const result = await makeApiRequest<{ ok: boolean }>(
			`${origin}/redirect/301/redirect/303/w/api.php`,
			{ action: 'query' },
		);

		expect(result).toEqual({ ok: true });
		expect(methodsAndBodies()).toEqual([
			{ method: 'GET', body: '' },
			{ method: 'GET', body: '' },
			{ method: 'GET', body: '' },
		]);
	});
});
