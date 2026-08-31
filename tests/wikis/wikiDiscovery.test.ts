import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupAddress } from 'node:dns';

vi.mock('../../src/transport/httpFetch.ts', () => ({
	makeApiRequest: vi.fn(),
	fetchPageHtml: vi.fn(),
}));

vi.mock('../../src/transport/ssrfGuard.ts', () => ({
	assertPublicDestination: vi.fn(),
}));

import { makeApiRequest, fetchPageHtml } from '../../src/transport/httpFetch.ts';
import { assertPublicDestination } from '../../src/transport/ssrfGuard.ts';
import { discoverWiki } from '../../src/wikis/wikiDiscovery.ts';
import { WikiTimeoutError } from '../../src/errors/wikiTimeoutError.ts';
import { callDeadline, WIKI_CONNECT_TIMEOUT_MS } from '../../src/runtime/callDeadline.ts';
import { rejectionOf } from '../helpers/rejectionOf.ts';

// assertPublicDestination resolves the addresses it validated, so a stubbed
// approval has to hand back a resolved public address, not nothing.
const publicAddresses: LookupAddress[] = [{ address: '93.184.216.34', family: 4 }];

const budget = () => callDeadline(WIKI_CONNECT_TIMEOUT_MS, 'connecting');

describe('discoverWiki', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertPublicDestination).mockResolvedValue(publicAddresses);
	});

	it('validates the supplied URL before any fetch', async () => {
		vi.mocked(assertPublicDestination).mockRejectedValueOnce(
			new Error(
				'Refusing to fetch URL resolving to non-public address 10.0.0.1 (private): http://10.0.0.1/',
			),
		);

		await expect(discoverWiki('http://10.0.0.1/', budget())).rejects.toThrow(/non-public/);
		expect(makeApiRequest).not.toHaveBeenCalled();
	});

	it('rejects a discovered server URL that resolves to a private address', async () => {
		vi.mocked(makeApiRequest).mockResolvedValue({
			query: {
				general: {
					sitename: 'Pretend Wiki',
					scriptpath: '/w',
					articlepath: '/wiki/$1',
					server: 'http://10.0.0.42',
					servername: '10.0.0.42',
				},
			},
		});
		vi.mocked(assertPublicDestination)
			.mockResolvedValueOnce(publicAddresses)
			.mockRejectedValueOnce(
				new Error(
					'Refusing to fetch URL resolving to non-public address 10.0.0.42 (private): http://10.0.0.42',
				),
			);

		await expect(discoverWiki('https://public.example/', budget())).rejects.toThrow(/10\.0\.0\.42/);
	});

	it('returns the WikiInfo when both the input URL and the discovered server are public', async () => {
		vi.mocked(makeApiRequest).mockResolvedValue({
			query: {
				general: {
					sitename: 'Public Wiki',
					scriptpath: '/w',
					articlepath: '/wiki/$1',
					server: 'https://public.example',
					servername: 'public.example',
				},
			},
		});

		const info = await discoverWiki('https://public.example/wiki/Main_Page', budget());

		expect(info).toEqual({
			sitename: 'Public Wiki',
			scriptpath: '/w',
			articlepath: '/wiki',
			server: 'https://public.example',
			servername: 'public.example',
		});
	});

	it('normalizes a protocol-relative MediaWiki server to https', async () => {
		vi.mocked(makeApiRequest).mockResolvedValue({
			query: {
				general: {
					sitename: 'MediaWiki',
					scriptpath: '/w',
					articlepath: '/wiki/$1',
					server: '//www.mediawiki.org',
					servername: 'www.mediawiki.org',
				},
			},
		});

		const info = await discoverWiki('https://www.mediawiki.org/wiki/Main_Page', budget());

		expect(info).toEqual({
			sitename: 'MediaWiki',
			scriptpath: '/w',
			articlepath: '/wiki',
			server: 'https://www.mediawiki.org',
			servername: 'www.mediawiki.org',
		});
	});

	it('bounds every request it makes, on one budget for the whole discovery', async () => {
		vi.mocked(makeApiRequest).mockResolvedValue({ query: {} });
		vi.mocked(fetchPageHtml).mockResolvedValue(null);

		await discoverWiki('https://public.example/wiki/Main_Page', budget());

		// `fetchCore` applies no timeout of its own, so a host that accepts the
		// connection and then goes quiet held add-wiki open until the OS gave up.
		const signals = vi
			.mocked(makeApiRequest)
			.mock.calls.map((call) => call[2]?.signal)
			.concat(vi.mocked(fetchPageHtml).mock.calls.map((call) => call[1]?.signal));
		expect(signals.length).toBeGreaterThan(1);
		expect(signals.every((signal) => signal !== undefined)).toBe(true);
		// One budget, not one per attempt: discovery tries up to five paths in
		// sequence, so a fresh budget each time would multiply the bound.
		expect(new Set(signals).size).toBe(1);
	});

	it('reports running out of time as a timeout, not as a URL that is not a wiki', async () => {
		// What an expired budget actually produces: `AbortSignal.timeout`'s reason
		// is a TimeoutError, and node-fetch raises AbortError. Driven directly so
		// the test does not wait out the real budget.
		vi.mocked(makeApiRequest).mockRejectedValue(
			new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
		);
		vi.mocked(fetchPageHtml).mockResolvedValue(null);

		const err = await discoverWiki('https://public.example/wiki/Main_Page', budget()).then(
			() => undefined,
			(e: unknown) => e,
		);

		// Returning null here would reach the caller as "ensure the URL is correct
		// and the wiki is accessible", sending them after a typo that is not there.
		expect(err).toBeInstanceOf(WikiTimeoutError);
		expect((err as WikiTimeoutError).phase).toBe('connecting');
	});

	it('still reports a host that answers but is not a wiki as not a wiki', async () => {
		vi.mocked(makeApiRequest).mockResolvedValue({ query: {} });
		vi.mocked(fetchPageHtml).mockResolvedValue(null);

		await expect(
			discoverWiki('https://public.example/wiki/Main_Page', budget()),
		).resolves.toBeNull();
	});
	it('falls through a wrong script path to the next candidate', async () => {
		vi.mocked(makeApiRequest)
			.mockRejectedValueOnce(new Error('HTTP error! status: 404 for URL: /w/api.php'))
			.mockResolvedValueOnce({
				query: {
					general: {
						sitename: 'Public Wiki',
						scriptpath: '',
						articlepath: '/wiki/$1',
						server: 'https://public.example',
						servername: 'public.example',
					},
				},
			});

		// Only running out of time ends discovery. Treating every failure as one
		// would turn each 404 — the normal answer from a path this wiki does not
		// use — into a bogus timeout.
		await expect(
			discoverWiki('https://public.example/wiki/Main_Page', budget()),
		).resolves.toMatchObject({ servername: 'public.example', scriptpath: '' });
	});

	it('gives up on a host that accepts the connection and then goes quiet', async () => {
		vi.mocked(makeApiRequest).mockImplementation(
			async (_url, _params, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => {
						reject(options.signal?.reason);
					});
				}),
		);
		vi.mocked(fetchPageHtml).mockResolvedValue(null);

		// The budget is the caller's, so this observes it actually firing rather
		// than only that a signal was threaded through. `AbortSignal.timeout` is
		// not advanceable by vitest's fake clock, so the budget is small and real.
		const err = await rejectionOf(
			discoverWiki('https://public.example/wiki/Main_Page', callDeadline(20, 'connecting')),
		);

		expect(err).toBeInstanceOf(WikiTimeoutError);
	});
	it('reports a budget spent on the page fetch, even when the retry fails for its own reason', async () => {
		// `fetchPageHtml` reports every failure as no content, an abort included.
		vi.mocked(fetchPageHtml).mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return null;
		});
		// The retry that follows fails for a reason of its own — a DNS lookup that
		// stops resolving, say — so it does not re-raise the abort on discovery's
		// behalf, and without the check the timeout is simply lost.
		vi.mocked(makeApiRequest).mockRejectedValue(
			Object.assign(new Error('getaddrinfo ENOTFOUND public.example'), { code: 'ENOTFOUND' }),
		);

		const err = await rejectionOf(
			discoverWiki('https://public.example/wiki/Main_Page', callDeadline(20, 'connecting')),
		);

		expect(err).toBeInstanceOf(WikiTimeoutError);
	});
});
