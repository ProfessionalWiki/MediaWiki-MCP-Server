import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WikiProbeImpl } from '../../src/wikis/wikiProbe.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { fakeClock } from '../helpers/fakeClock.ts';

vi.mock('../../src/transport/httpFetch.ts', () => ({
	makeApiRequest: vi.fn(),
}));

import { makeApiRequest } from '../../src/transport/httpFetch.ts';

const baseWiki: WikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
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

// Whether the probe's snapshot of the wiki lists the extension.
async function has(probe: WikiProbeImpl, wikiKey: string, extension: string): Promise<boolean> {
	return (await probe.inspect(wikiKey)).extensions.has(extension);
}

beforeEach(() => {
	vi.mocked(makeApiRequest).mockReset();
});

afterEach(() => {
	vi.useRealTimers();
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

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		expect(await has(probe, 'a', 'OAuth')).toBe(true);
		expect(await has(probe, 'a', 'NonExistent')).toBe(false);
	});

	it('measures its cache TTL monotonically, so a wall-clock jump does not re-probe', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.mocked(makeApiRequest).mockResolvedValue({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		// The production clock, not an injected one.
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		// Two hours of wall clock, past the one-hour TTL, but no running time.
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);

		expect(makeApiRequest).toHaveBeenCalledTimes(1);
	});

	it('issues exactly one HTTP request for several lookups within TTL', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		await has(probe, 'a', 'SemanticMediaWiki');
		await has(probe, 'a', 'SemanticMediaWiki');
		await has(probe, 'a', 'OAuth');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('re-probes after the 1-hour TTL', async () => {
		vi.mocked(makeApiRequest)
			.mockResolvedValueOnce({ query: { extensions: [{ name: 'SemanticMediaWiki' }] } })
			.mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		clock.advance(60 * 60 * 1000 + 1); // 1h + 1ms
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('caches a failed sentinel for 60 seconds on probe failure', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		// Within 60s, no re-probe.
		clock.advance(30_000);
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);

		// After 60s, retry.
		clock.advance(31_000);
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
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

		const p1 = has(probe, 'a', 'SemanticMediaWiki');
		const p2 = has(probe, 'a', 'OAuth');
		const p3 = has(probe, 'a', 'NotInstalled');

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

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		probe.invalidate('a');
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('builds the API URL from server + scriptpath + /api.php', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		await has(probe, 'a', 'SemanticMediaWiki');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledWith(
			'https://test.wiki/w/api.php',
			expect.objectContaining({
				action: 'query',
				meta: 'siteinfo',
				siprop: 'extensions|general',
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

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
	});

	it('returns false when the wiki key is unknown', async () => {
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({}), clock.now);

		expect(await has(probe, 'unknown', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
	});

	it('treats malformed responses as probe failures', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: undefined });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		// 60s short backoff applies.
		clock.advance(30_000);
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('inspect returns reachable=false with an empty set when the probe fails', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), clock.now);

		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
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

	describe('public identity', () => {
		it('inspect surfaces the server from siteinfo', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'Cargo' }],
					general: { server: 'https://public.example' },
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect(result.server).toBe('https://public.example');
		});

		it('inspect surfaces the query service endpoint a Wikibase repository publishes', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'WikibaseRepository' }],
					general: {
						server: 'https://www.wikidata.org',
						'wikibase-sparql': 'https://query.wikidata.org/sparql',
					},
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect((await probe.inspect('a')).sparqlEndpoint).toBe('https://query.wikidata.org/sparql');
		});

		it('omits the query service endpoint when siteinfo does not publish one', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'WikibaseRepository' }],
					general: { server: 'https://repo.example' },
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			expect((await probe.inspect('a')).sparqlEndpoint).toBeUndefined();
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
		});

		it('omits identity fields when the probe fails', async () => {
			vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }));

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(result.server).toBeUndefined();
		});
	});
});
