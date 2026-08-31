import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupAddress } from 'node:dns';

vi.mock('../../src/transport/httpFetch.ts', () => ({
	makeApiRequest: vi.fn(),
	fetchPageHtml: vi.fn(),
}));

vi.mock('../../src/transport/ssrfGuard.ts', () => ({
	assertPublicDestination: vi.fn(),
}));

import { makeApiRequest } from '../../src/transport/httpFetch.ts';
import { assertPublicDestination } from '../../src/transport/ssrfGuard.ts';
import { discoverWiki } from '../../src/wikis/wikiDiscovery.ts';

// assertPublicDestination resolves the addresses it validated, so a stubbed
// approval has to hand back a resolved public address, not nothing.
const publicAddresses: LookupAddress[] = [{ address: '93.184.216.34', family: 4 }];

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

		await expect(discoverWiki('http://10.0.0.1/')).rejects.toThrow(/non-public/);
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

		await expect(discoverWiki('https://public.example/')).rejects.toThrow(/10\.0\.0\.42/);
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

		const info = await discoverWiki('https://public.example/wiki/Main_Page');

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

		const info = await discoverWiki('https://www.mediawiki.org/wiki/Main_Page');

		expect(info).toEqual({
			sitename: 'MediaWiki',
			scriptpath: '/w',
			articlepath: '/wiki',
			server: 'https://www.mediawiki.org',
			servername: 'www.mediawiki.org',
		});
	});
});
