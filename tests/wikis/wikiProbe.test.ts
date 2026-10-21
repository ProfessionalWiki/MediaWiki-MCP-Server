import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WikiProbeImpl } from '../../src/wikis/wikiProbe.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import type { MwnProvider } from '../../src/wikis/mwnProvider.ts';
import { fakeClock } from '../helpers/fakeClock.ts';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { withRequestFields } from '../../src/runtime/requestContext.ts';
import { siteinfoAnswer } from '../helpers/siteinfoAnswer.ts';
import { wikiAnswering } from '../helpers/wikiAnswering.ts';

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

// A public wiki answers the anonymous probe, so the probe never needs the
// wiki's own session, whose credentials may be resolved by running a command.
const noSessions: MwnProvider = {
	get: async () => {
		throw new Error('The probe asked for a session');
	},
	invalidate: () => {},
};

// The wiki's own session, answering siteinfo with `response`.
function sessionAnswering(response: unknown): MwnProvider {
	const mwn = createMockMwn({ request: vi.fn().mockResolvedValue(response) });
	return { get: async () => mwn as never, invalidate: () => {} };
}

const CARGO_SITEINFO = { query: { extensions: [{ name: 'Cargo' }] } };
const READ_REFUSED = {
	error: { code: 'readapidenied', info: 'You need read permission to use this module.' },
};

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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		await has(probe, 'a', 'SemanticMediaWiki');
		await has(probe, 'a', 'SemanticMediaWiki');
		await has(probe, 'a', 'OAuth');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('re-probes after the 1-hour TTL, taking up what the wiki now reports', async () => {
		vi.mocked(makeApiRequest)
			.mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'SemanticMediaWiki' }],
					general: { server: 'https://old.example' },
				},
			})
			.mockResolvedValueOnce({
				query: { extensions: [], general: { server: 'https://new.example' } },
			});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		clock.advance(60 * 60 * 1000 + 1); // 1h + 1ms
		const refreshed = await probe.inspect('a');

		expect(refreshed.extensions.has('SemanticMediaWiki')).toBe(false);
		expect(refreshed.server).toBe('https://new.example');
	});

	it('caches a failed sentinel for 60 seconds on probe failure', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(true);
		probe.invalidate('a');
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('builds the API URL from server + scriptpath + /api.php', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		await has(probe, 'a', 'SemanticMediaWiki');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledWith(
			'https://test.wiki/w/api.php',
			expect.objectContaining({ action: 'query', meta: 'siteinfo' }),
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
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
	});

	it('returns false when the wiki key is unknown', async () => {
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({}), noSessions, clock.now);

		expect(await has(probe, 'unknown', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
	});

	it('treats malformed responses as probe failures', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: undefined });
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		// 60s short backoff applies.
		clock.advance(30_000);
		expect(await has(probe, 'a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('inspect returns reachable=false with an empty set when the probe fails', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		const result = await probe.inspect('a');
		expect(result.reachable).toBe(false);
		expect(result.extensions.size).toBe(0);
	});

	it('inspect returns reachable=true with the detected extension set', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'Cargo' }, { name: 'OAuth' }] },
		});
		const clock = fakeClock();
		const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

		const result = await probe.inspect('a');
		expect(result.reachable).toBe(true);
		expect([...result.extensions].sort()).toEqual(['Cargo', 'OAuth']);
	});

	describe('a wiki that refuses anonymous reads', () => {
		it("reads siteinfo through the wiki's own session when the anonymous probe is refused", async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(READ_REFUSED);
			const probe = new WikiProbeImpl(
				makeRegistry({ a: baseWiki }),
				sessionAnswering(CARGO_SITEINFO),
			);

			expect(await probe.inspect('a')).toMatchObject({ reachable: true });
			expect(await has(probe, 'a', 'Cargo')).toBe(true);
		});

		it('asks a wiki configured private through its own session, without an anonymous probe', async () => {
			const probe = new WikiProbeImpl(
				makeRegistry({ a: { ...baseWiki, private: true } }),
				sessionAnswering(CARGO_SITEINFO),
			);

			expect(await has(probe, 'a', 'Cargo')).toBe(true);
			expect(makeApiRequest).not.toHaveBeenCalled();
		});

		// Handed to every concurrent caller, so it runs on a budget of its own: a
		// joiner must not be dropped onto a failure by a caller that walked away.
		it('bounds the session read with a budget of its own, not the caller that started it', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(READ_REFUSED);
			const session = wikiAnswering(CARGO_SITEINFO);
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), {
				get: async () => session.mwn,
				invalidate: () => {},
			});
			const caller = new AbortController();
			caller.abort();

			await withRequestFields({ signal: caller.signal }, () => probe.inspect('a'));

			expect(session.sentSignal()).toBeInstanceOf(AbortSignal);
			expect(session.sentSignal()?.aborted).toBe(false);
		});

		it('reports the wiki unreachable when its own session is refused too', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce(READ_REFUSED);
			const refusingSession: MwnProvider = {
				get: async () => {
					throw new Error('Failed to log in');
				},
				invalidate: () => {},
			};
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), refusingSession);

			expect(await probe.inspect('a')).toMatchObject({ reachable: false });
		});
	});

	describe('public identity', () => {
		it('inspect surfaces the server from siteinfo', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'Cargo' }],
					general: { server: 'https://public.example' },
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

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
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).sparqlEndpoint).toBe('https://query.wikidata.org/sparql');
		});

		it('omits the query service endpoint when siteinfo does not publish one', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: {
					extensions: [{ name: 'WikibaseRepository' }],
					general: { server: 'https://repo.example' },
				},
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).sparqlEndpoint).toBeUndefined();
		});

		it('normalizes a protocol-relative server to https', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [], general: { server: '//public.example' } },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).server).toBe('https://public.example');
		});

		it('omits identity fields absent from siteinfo on an otherwise successful probe', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'Cargo' }] },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(true);
			expect(result.server).toBeUndefined();
		});

		it('omits identity fields when the wiki has never answered', async () => {
			vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			const result = await probe.inspect('a');
			expect(result.reachable).toBe(false);
			expect(result.server).toBeUndefined();
		});

		it('inspect surfaces the article path, content language and license', async () => {
			vi.mocked(makeApiRequest).mockImplementation(async (_url, params) =>
				siteinfoAnswer(
					{
						extensions: [],
						general: { server: 'https://public.example', articlepath: '/wiki/$1', lang: 'de' },
						rightsinfo: {
							url: 'https://creativecommons.org/licenses/by-sa/4.0/',
							text: 'CC BY-SA 4.0',
						},
					},
					params,
				),
			);
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect(await probe.inspect('a')).toMatchObject({
				articlepath: '/wiki',
				lang: 'de',
				license: { url: 'https://creativecommons.org/licenses/by-sa/4.0/', title: 'CC BY-SA 4.0' },
			});
		});

		it('omits the license when the wiki has none', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [], rightsinfo: { url: '', text: '' } },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).license).toBeUndefined();
		});

		// An empty server would make every link relative.
		it('leaves out a server siteinfo reports as empty', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [], general: { server: '' } },
			});
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).server).toBeUndefined();
		});

		it('keeps the namespaces the wiki counts as content, leaving out those the search API refuses', async () => {
			vi.mocked(makeApiRequest).mockImplementation(async (_url, params) =>
				siteinfoAnswer(
					{
						extensions: [],
						namespaces: {
							'-1': { id: -1, content: true },
							'0': { id: 0, content: true },
							'4': { id: 4, content: false },
							'120': { id: 120, content: true },
						},
					},
					params,
				),
			);
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).contentNamespaces).toEqual([0, 120]);
		});

		it('omits the content namespaces when siteinfo reports no namespace map', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: { extensions: [] } });
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions);

			expect((await probe.inspect('a')).contentNamespaces).toBeUndefined();
		});

		// Links stay public through a blip, while the extension tools follow the
		// wiki's current state.
		it('keeps the identity it last read when a refetch fails', async () => {
			vi.mocked(makeApiRequest)
				.mockResolvedValueOnce({
					query: { extensions: [{ name: 'Cargo' }], general: { server: 'https://public.example' } },
				})
				.mockRejectedValueOnce(new Error('network down'))
				.mockRejectedValueOnce(new Error('network down'));
			const clock = fakeClock();
			const probe = new WikiProbeImpl(makeRegistry({ a: baseWiki }), noSessions, clock.now);

			await probe.inspect('a');
			clock.advance(60 * 60 * 1000 + 1);
			await probe.inspect('a');
			clock.advance(60 * 1000 + 1);
			const result = await probe.inspect('a');

			expect(result.reachable).toBe(false);
			expect(result.extensions.size).toBe(0);
			expect(result.server).toBe('https://public.example');
		});
	});
});
