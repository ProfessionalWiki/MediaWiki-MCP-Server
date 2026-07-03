import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WikiProbeImpl } from '../../src/wikis/wikiProbe.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import type { MwnProvider } from '../../src/wikis/mwnProvider.js';
import { fakeClock } from '../helpers/fakeClock.js';

vi.mock('../../src/transport/httpFetch.js', () => ({
	makeApiRequest: vi.fn(),
}));

import { makeApiRequest } from '../../src/transport/httpFetch.js';

const baseWiki: WikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
};

const authenticatedWiki: WikiConfig = {
	...baseWiki,
	username: 'bot@bot',
	password: 'secret',
};

const readapidenied = {
	error: { code: 'readapidenied', info: 'You need read permission to use this module.' },
};

function makeRegistry(wikis: Record<string, WikiConfig>): WikiRegistry {
	return {
		getAll: () => wikis,
		get: (key) => wikis[key],
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => true,
	};
}

// Minimal stand-in for the authenticated `Mwn` instance MwnProvider.get()
// resolves to — only `.request()` is exercised by the probe's retry path.
function makeMwnProvider(request: (params: unknown) => Promise<unknown>): MwnProvider {
	return {
		get: () => Promise.resolve({ request } as unknown as Awaited<ReturnType<MwnProvider['get']>>),
		invalidate: () => {},
	};
}

beforeEach(() => {
	vi.mocked(makeApiRequest).mockReset();
});

describe('WikiProbeImpl', () => {
	it('returns true when the named extension is present in siteinfo.extensions', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: {
				extensions: [
					{ name: 'SemanticMediaWiki', type: 'parserhook' },
					{ name: 'OAuth', type: 'specialpage' },
				],
			},
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(true);
		expect(await probe.hasExtension('a', 'OAuth')).toBe(true);
		expect(await probe.hasExtension('a', 'NonExistent')).toBe(false);
	});

	it('issues exactly one HTTP request for multiple hasExtension() calls within TTL', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		await probe.hasExtension('a', 'SemanticMediaWiki');
		await probe.hasExtension('a', 'SemanticMediaWiki');
		await probe.hasExtension('a', 'OAuth');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('re-probes after the 1-hour TTL', async () => {
		vi.mocked(makeApiRequest)
			.mockResolvedValueOnce({ query: { extensions: [{ name: 'SemanticMediaWiki' }] } })
			.mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(true);
		clock.advance(60 * 60 * 1000 + 1); // 1h + 1ms
		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('caches a failed sentinel for 60 seconds on probe failure', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		// Within 60s, no re-probe.
		clock.advance(30_000);
		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);

		// After 60s, retry.
		clock.advance(31_000);
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(true);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('coalesces concurrent probes for the same uncached wiki (single-flight)', async () => {
		let resolveProbe: (v: unknown) => void = () => {};
		vi.mocked(makeApiRequest).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		const p1 = probe.hasExtension('a', 'SemanticMediaWiki');
		const p2 = probe.hasExtension('a', 'OAuth');
		const p3 = probe.hasExtension('a', 'NotInstalled');

		// All three calls share one in-flight probe.
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);

		resolveProbe({ query: { extensions: [{ name: 'SemanticMediaWiki' }, { name: 'OAuth' }] } });
		expect(await p1).toBe(true);
		expect(await p2).toBe(true);
		expect(await p3).toBe(false);
	});

	it('invalidate drops the entry; next call re-probes', async () => {
		vi.mocked(makeApiRequest)
			.mockResolvedValueOnce({ query: { extensions: [{ name: 'SemanticMediaWiki' }] } })
			.mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(true);
		probe.invalidate('a');
		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('builds the API URL from server + scriptpath + /api.php', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		await probe.hasExtension('a', 'SemanticMediaWiki');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledWith(
			'https://test.wiki/w/api.php',
			expect.objectContaining({
				action: 'query',
				meta: 'siteinfo',
				siprop: 'extensions|general|rightsinfo',
				format: 'json',
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('treats an aborted/timed-out probe as a probe failure', async () => {
		// AbortSignal.timeout surfaces as a rejection (DOMException / Error
		// named 'TimeoutError' or 'AbortError') — it must land in probe()'s
		// catch and resolve as a `failed` entry, exactly like any other failure.
		const abortError = new Error('The operation was aborted');
		abortError.name = 'TimeoutError';
		vi.mocked(makeApiRequest).mockRejectedValueOnce(abortError);
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
	});

	it('returns false when the wiki key is unknown', async () => {
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({}), clock.now);

		expect(await probe.hasExtension('unknown', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
	});

	it('treats malformed responses as probe failures', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: undefined });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		// 60s short backoff applies.
		clock.advance(30_000);
		expect(await probe.hasExtension('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	describe('anonymous read denied', () => {
		it('fails without retrying when the wiki has no configured credentials', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(readapidenied);
			const clock = fakeClock();
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
		});

		it('fails without retrying when no MwnProvider was supplied', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(readapidenied);
			const clock = fakeClock();
			const probe = new WikiProbeImpl(makeRegistry({ a: authenticatedWiki }), clock.now);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
		});

		it('retries authenticated and succeeds when the wiki has credentials configured', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(readapidenied);
			const request = vi.fn().mockResolvedValue({
				query: { extensions: [{ name: 'SemanticMediaWiki' }] },
			});
			const clock = fakeClock();
			const probe = new WikiProbeImpl(
				makeRegistry({ a: authenticatedWiki }),
				clock.now,
				makeMwnProvider(request),
			);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect([...result.extensions]).toEqual(['SemanticMediaWiki']);
			expect(request).toHaveBeenCalledWith(
				expect.objectContaining({ action: 'query', meta: 'siteinfo' }),
			);
		});

		it('fails with a combined reason when the authenticated retry also fails', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(readapidenied);
			const request = vi.fn().mockRejectedValue(new Error('still denied'));
			const clock = fakeClock();
			const probe = new WikiProbeImpl(
				makeRegistry({ a: authenticatedWiki }),
				clock.now,
				makeMwnProvider(request),
			);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(request).toHaveBeenCalledTimes(1);
		});
	});

	describe('private: true wikis', () => {
		const privateWiki: WikiConfig = { ...authenticatedWiki, private: true };

		it('skips the anonymous request entirely and probes authenticated', async () => {
			const request = vi.fn().mockResolvedValue({
				query: { extensions: [{ name: 'SemanticMediaWiki' }] },
			});
			const probe = new WikiProbeImpl(
				makeRegistry({ a: privateWiki }),
				undefined,
				makeMwnProvider(request),
			);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect([...result.extensions]).toEqual(['SemanticMediaWiki']);
			expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
			expect(request).toHaveBeenCalledTimes(1);
		});

		it('fails cleanly when marked private but no credentials are configured', async () => {
			const probe = new WikiProbeImpl(
				makeRegistry({ a: { ...baseWiki, private: true } }),
				undefined,
				makeMwnProvider(vi.fn()),
			);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
		});
	});

	describe('hasAnyExtension', () => {
		it('returns true when any of the given names matches', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'LIBRARIAN' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect(await probe.hasAnyExtension('a', ['Cargo', 'LIBRARIAN'])).toBe(true);
		});

		it('returns false when none of the given names match', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'OAuth' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect(await probe.hasAnyExtension('a', ['Cargo', 'LIBRARIAN'])).toBe(false);
		});

		it('returns false on probe failure', async () => {
			vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect(await probe.hasAnyExtension('a', ['Cargo', 'LIBRARIAN'])).toBe(false);
		});

		it('returns false on an empty names list', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'Cargo' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect(await probe.hasAnyExtension('a', [])).toBe(false);
		});

		it('shares the same cache as hasExtension()', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'LIBRARIAN' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect(await probe.hasExtension('a', 'OAuth')).toBe(false);
			expect(await probe.hasAnyExtension('a', ['Cargo', 'LIBRARIAN'])).toBe(true);
			expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
		});
	});

	it('inspect returns reachable=true with the detected extension set', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'Cargo' }, { name: 'OAuth' }] },
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		const result = await probe.inspect('a');
		expect(result.reachable).toBe(true);
		expect([...result.extensions].sort()).toEqual(['Cargo', 'OAuth']);
	});

	it('inspect returns reachable=false with an empty set when the probe fails', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
	});

	it('inspect reuses the cache — no second HTTP request after hasExtension()', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'Cargo' }] },
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		await probe.hasExtension('a', 'Cargo');
		await probe.inspect('a');
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	describe('public identity', () => {
		it('inspect surfaces server, articlepath, and license from siteinfo', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'Cargo' }],
					general: { server: 'https://public.example', articlepath: '/wiki/$1' },
					rightsinfo: {
						url: 'https://creativecommons.org/licenses/by-sa/4.0/',
						text: 'CC BY-SA 4.0',
					},
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect(result.server).toBe('https://public.example');
			expect(result.articlepath).toBe('/wiki');
			expect(result.license).toEqual({
				url: 'https://creativecommons.org/licenses/by-sa/4.0/',
				title: 'CC BY-SA 4.0',
			});
		});

		it('normalizes a protocol-relative server to https', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [], general: { server: '//public.example' } },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect((await probe.inspect('a')).server).toBe('https://public.example');
		});

		it('omits identity fields absent from siteinfo on an otherwise successful probe', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'Cargo' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect(result.server).toBeUndefined();
			expect(result.articlepath).toBeUndefined();
			expect(result.license).toBeUndefined();
		});

		it('omits the license when rightsinfo lacks a url or text', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [], rightsinfo: { text: 'All rights reserved' } },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect((await probe.inspect('a')).license).toBeUndefined();
		});

		it('omits identity fields when the probe fails', async () => {
			vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(result.server).toBeUndefined();
			expect(result.articlepath).toBeUndefined();
			expect(result.license).toBeUndefined();
		});
	});
});
