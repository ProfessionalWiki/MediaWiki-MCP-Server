import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', async () => {
	const actual = await vi.importActual<typeof import('node-fetch')>('node-fetch');
	return {
		...actual,
		default: vi.fn(),
	};
});

vi.mock('../../src/transport/ssrfGuard.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/ssrfGuard.ts')>(
		'../../src/transport/ssrfGuard.ts',
	);
	return { ...actual, assertPublicDestination: vi.fn(), buildPinnedAgent: vi.fn() };
});

import fetch, { Response, FetchError } from 'node-fetch';
import {
	assertPublicDestination,
	buildPinnedAgent,
	SsrfValidationError,
} from '../../src/transport/ssrfGuard.ts';
import {
	makeApiRequest,
	postForm,
	fetchPageHtml,
	fetchFileBytes,
	shouldRescueToWiki,
	HttpStatusError,
	FileTooLargeError,
} from '../../src/transport/httpFetch.ts';

describe('utils.fetchCore (via makeApiRequest / fetchPageHtml)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertPublicDestination).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		vi.mocked(buildPinnedAgent).mockReturnValue({ __pinned: true } as never);
	});

	it('calls assertPublicDestination with the final URL before fetching', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

		await makeApiRequest('https://example.com/w/api.php', { action: 'query' });

		expect(assertPublicDestination).toHaveBeenCalledWith(
			'https://example.com/w/api.php?action=query',
		);
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/w/api.php?action=query',
			expect.objectContaining({ redirect: 'manual' }),
		);
	});

	it('pins DNS by passing an Agent built from the resolved addresses to fetch', async () => {
		const resolved = [{ address: '93.184.216.34', family: 4 as const }];
		vi.mocked(assertPublicDestination).mockResolvedValueOnce(resolved);
		const pinned = { __pinned: 'v4-agent' } as never;
		vi.mocked(buildPinnedAgent).mockReturnValueOnce(pinned);
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

		await makeApiRequest('https://example.com/w/api.php');

		expect(buildPinnedAgent).toHaveBeenCalledWith('https://example.com/w/api.php', resolved);
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/w/api.php',
			expect.objectContaining({ agent: pinned }),
		);
	});

	it('rebuilds the pinned Agent per redirect hop from fresh resolved addresses', async () => {
		const firstHop = [{ address: '93.184.216.34', family: 4 as const }];
		const secondHop = [{ address: '151.101.1.69', family: 4 as const }];
		vi.mocked(assertPublicDestination)
			.mockResolvedValueOnce(firstHop)
			.mockResolvedValueOnce(secondHop);
		const firstAgent = { __pinned: 'first' } as never;
		const secondAgent = { __pinned: 'second' } as never;
		vi.mocked(buildPinnedAgent).mockReturnValueOnce(firstAgent).mockReturnValueOnce(secondAgent);
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: 'https://other.example/api.php' } }),
			)
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		await makeApiRequest<{ ok: boolean }>('https://start.example/api.php');

		expect(buildPinnedAgent).toHaveBeenNthCalledWith(1, 'https://start.example/api.php', firstHop);
		expect(buildPinnedAgent).toHaveBeenNthCalledWith(2, 'https://other.example/api.php', secondHop);
		expect(fetch).toHaveBeenNthCalledWith(
			1,
			'https://start.example/api.php',
			expect.objectContaining({ agent: firstAgent }),
		);
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'https://other.example/api.php',
			expect.objectContaining({ agent: secondAgent }),
		);
	});

	it('throws without calling fetch when the guard rejects the URL', async () => {
		vi.mocked(assertPublicDestination).mockRejectedValueOnce(
			new Error(
				'Refusing to fetch URL resolving to non-public address 127.0.0.1 (loopback): http://127.0.0.1/',
			),
		);

		await expect(makeApiRequest('http://127.0.0.1/w/api.php')).rejects.toThrow(/non-public/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fetchPageHtml swallows guard rejections and returns null', async () => {
		vi.mocked(assertPublicDestination).mockRejectedValueOnce(
			new Error('Refusing to fetch URL with unsupported scheme "file:": file:///etc/passwd'),
		);

		const result = await fetchPageHtml('file:///etc/passwd');

		expect(result).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('follows a 302 redirect only after the guard approves the Location target', async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { Location: 'https://redirected.example/api.php' },
				}),
			)
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		const result = await makeApiRequest<{ ok: boolean }>('https://start.example/api.php');

		expect(result).toEqual({ ok: true });
		expect(assertPublicDestination).toHaveBeenNthCalledWith(1, 'https://start.example/api.php');
		expect(assertPublicDestination).toHaveBeenNthCalledWith(
			2,
			'https://redirected.example/api.php',
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('rejects a redirect whose Location resolves to a private address', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { Location: 'https://169.254.169.254/latest/meta-data/' },
			}),
		);
		vi.mocked(assertPublicDestination)
			.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
			.mockRejectedValueOnce(
				new Error(
					'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): https://169.254.169.254/latest/meta-data/',
				),
			);

		await expect(makeApiRequest('https://start.example/api.php')).rejects.toThrow(
			/169\.254\.169\.254/,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('resolves a protocol-relative Location against the previous URL before revalidating', async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: '//other.example/api.php' } }),
			)
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		await makeApiRequest('https://start.example/api.php');

		expect(assertPublicDestination).toHaveBeenNthCalledWith(2, 'https://other.example/api.php');
	});

	it('resolves a path-only Location against the previous URL before revalidating', async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: '/elsewhere/api.php' } }),
			)
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		await makeApiRequest('https://start.example/w/api.php');

		expect(assertPublicDestination).toHaveBeenNthCalledWith(
			2,
			'https://start.example/elsewhere/api.php',
		);
	});

	it('caps the redirect chain at five hops', async () => {
		for (let i = 0; i < 10; i++) {
			vi.mocked(fetch).mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { Location: `https://hop${i + 1}.example/` } }),
			);
		}

		await expect(makeApiRequest('https://start.example/api.php')).rejects.toThrow(/redirect/i);
		expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(6);
	});
});

describe('fetchFileBytes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertPublicDestination).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		vi.mocked(buildPinnedAgent).mockReturnValue({ __pinned: true } as never);
	});

	it('returns the body bytes when under the cap', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(Buffer.from('hello'), { status: 200, headers: { 'content-length': '5' } }),
		);
		const buf = await fetchFileBytes('https://src.example/cat.jpg', { maxBytes: 1024 });
		expect(buf.toString()).toBe('hello');
	});

	it('throws FileTooLargeError when content-length exceeds the cap', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(Buffer.from('hello'), { status: 200, headers: { 'content-length': '5' } }),
		);
		await expect(
			fetchFileBytes('https://src.example/big.bin', { maxBytes: 3 }),
		).rejects.toBeInstanceOf(FileTooLargeError);
	});

	it('throws FileTooLargeError when the streamed body exceeds the cap', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(Buffer.from('hello'), { status: 200 }));
		await expect(
			fetchFileBytes('https://src.example/big.bin', { maxBytes: 3 }),
		).rejects.toBeInstanceOf(FileTooLargeError);
	});

	it('throws HttpStatusError on a non-2xx source response', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 404 }));
		await expect(fetchFileBytes('https://src.example/missing.jpg')).rejects.toBeInstanceOf(
			HttpStatusError,
		);
	});
});

describe('shouldRescueToWiki', () => {
	it('rescues on reachability/size failures, not on HTTP status', () => {
		expect(shouldRescueToWiki(new HttpStatusError(404, 'https://x/'))).toBe(false);
		expect(shouldRescueToWiki(new FileTooLargeError(10, 5))).toBe(true);
		expect(shouldRescueToWiki(new SsrfValidationError('nope'))).toBe(true);
		expect(shouldRescueToWiki(new FetchError('boom', 'system'))).toBe(true);
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		expect(shouldRescueToWiki(abort)).toBe(true);
		expect(shouldRescueToWiki(new Error('other'))).toBe(false);
	});

	it('rescues on Node reachability syscall codes (DNS / connection failures)', () => {
		// DNS failure surfaces from assertPublicDestination's lookup, before
		// node-fetch — a plain Error with a syscall code, not a FetchError.
		const dnsFail = Object.assign(new Error('getaddrinfo ENOTFOUND src.example'), {
			code: 'ENOTFOUND',
		});
		expect(shouldRescueToWiki(dnsFail)).toBe(true);
		const transientDns = Object.assign(new Error('getaddrinfo EAI_AGAIN src.example'), {
			code: 'EAI_AGAIN',
		});
		expect(shouldRescueToWiki(transientDns)).toBe(true);
		const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		expect(shouldRescueToWiki(refused)).toBe(true);
		// A coded error that is NOT a reachability failure must not rescue.
		const other = Object.assign(new Error('boom'), { code: 'EPERM' });
		expect(shouldRescueToWiki(other)).toBe(false);
	});
});

describe('postForm', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertPublicDestination).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		vi.mocked(buildPinnedAgent).mockReturnValue({ __pinned: true } as never);
	});

	it('posts a form-encoded body through the guard and returns the response text', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response('results', { status: 200 }));

		const body = await postForm('https://query.example/sparql', { query: 'SELECT ?x WHERE {}' });

		expect(body).toBe('results');
		expect(assertPublicDestination).toHaveBeenCalledWith('https://query.example/sparql');
		expect(fetch).toHaveBeenCalledWith(
			'https://query.example/sparql',
			expect.objectContaining({
				method: 'POST',
				body: 'query=SELECT+%3Fx+WHERE+%7B%7D',
			}),
		);
	});

	it('sends the caller headers alongside the form content type', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response('results', { status: 200 }));

		await postForm(
			'https://query.example/sparql',
			{ query: 'x' },
			{ headers: { Accept: 'application/sparql-results+json' } },
		);

		expect(vi.mocked(fetch).mock.calls[0][1]!.headers).toMatchObject({
			Accept: 'application/sparql-results+json',
			'Content-Type': 'application/x-www-form-urlencoded',
		});
	});

	it('returns the whole body when no byte cap is given', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(Buffer.from('x'.repeat(5000))));

		const body = await postForm('https://query.example/sparql', { query: 'x' });

		expect(body).toHaveLength(5000);
	});

	it('returns the body when it is under the byte cap', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(Buffer.from('results'), { status: 200, headers: { 'content-length': '7' } }),
		);

		const body = await postForm('https://query.example/sparql', { query: 'x' }, { maxBytes: 1024 });

		expect(body).toBe('results');
	});

	it('refuses a body whose declared length exceeds the byte cap', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(Buffer.from('results'), { status: 200, headers: { 'content-length': '7' } }),
		);

		await expect(
			postForm('https://query.example/sparql', { query: 'x' }, { maxBytes: 3 }),
		).rejects.toBeInstanceOf(FileTooLargeError);
	});

	it('refuses a body that exceeds the byte cap while streaming', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(Buffer.from('results'), { status: 200 }));

		await expect(
			postForm('https://query.example/sparql', { query: 'x' }, { maxBytes: 3 }),
		).rejects.toBeInstanceOf(FileTooLargeError);
	});

	it('refuses an over-cap declared length before reading a byte of the body', async () => {
		// Seven bytes of body under a 1000-byte cap: only the declared length can
		// refuse this, and the size it reports is the one it read the header for.
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(Buffer.from('results'), { status: 200, headers: { 'content-length': '5000' } }),
		);

		const error = await postForm(
			'https://query.example/sparql',
			{ query: 'x' },
			{ maxBytes: 1000 },
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(FileTooLargeError);
		expect((error as FileTooLargeError).size).toBe(5000);
	});

	it('reports a rejected request with the status and the response body', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response('MalformedQueryException', { status: 400 }),
		);

		const error = await postForm('https://query.example/sparql', { query: 'x' }).catch(
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(HttpStatusError);
		expect((error as HttpStatusError).status).toBe(400);
		expect((error as HttpStatusError).body).toBe('MalformedQueryException');
	});
});
