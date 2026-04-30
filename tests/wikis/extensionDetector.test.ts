import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionDetectorImpl } from '../../src/wikis/extensionDetector.js';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
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

function makeRegistry(wikis: Record<string, WikiConfig>): WikiRegistry {
	return {
		getAll: () => wikis,
		get: (key) => wikis[key],
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => true,
	};
}

beforeEach(() => {
	vi.mocked(makeApiRequest).mockReset();
});

describe('ExtensionDetectorImpl', () => {
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
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(true);
		expect(await detector.has('a', 'OAuth')).toBe(true);
		expect(await detector.has('a', 'NonExistent')).toBe(false);
	});

	it('issues exactly one HTTP request for multiple has() calls within TTL', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		await detector.has('a', 'SemanticMediaWiki');
		await detector.has('a', 'SemanticMediaWiki');
		await detector.has('a', 'OAuth');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	it('re-probes after the 1-hour TTL', async () => {
		vi.mocked(makeApiRequest)
			.mockResolvedValueOnce({ query: { extensions: [{ name: 'SemanticMediaWiki' }] } })
			.mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(true);
		clock.advance(60 * 60 * 1000 + 1); // 1h + 1ms
		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('caches a failed sentinel for 60 seconds on probe failure', async () => {
		vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);
		// Within 60s, no re-probe.
		clock.advance(30_000);
		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);

		// After 60s, retry.
		clock.advance(31_000);
		vi.mocked(makeApiRequest).mockResolvedValueOnce({
			query: { extensions: [{ name: 'SemanticMediaWiki' }] },
		});
		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(true);
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
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		const p1 = detector.has('a', 'SemanticMediaWiki');
		const p2 = detector.has('a', 'OAuth');
		const p3 = detector.has('a', 'NotInstalled');

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
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(true);
		detector.invalidate('a');
		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(2);
	});

	it('builds the API URL from server + scriptpath + /api.php', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: { extensions: [] } });
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		await detector.has('a', 'SemanticMediaWiki');

		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledWith(
			'https://test.wiki/w/api.php',
			expect.objectContaining({
				action: 'query',
				meta: 'siteinfo',
				siprop: 'extensions',
				format: 'json',
			}),
		);
	});

	it('returns false when the wiki key is unknown', async () => {
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({}), clock.now);

		expect(await detector.has('unknown', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).not.toHaveBeenCalled();
	});

	it('treats malformed responses as probe failures', async () => {
		vi.mocked(makeApiRequest).mockResolvedValueOnce({ query: undefined });
		const clock = fakeClock();
		const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }), clock.now);

		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);
		// 60s short backoff applies.
		clock.advance(30_000);
		expect(await detector.has('a', 'SemanticMediaWiki')).toBe(false);
		expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
	});

	describe('hasAny', () => {
		it('returns true when any of the given names matches', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'LIBRARIAN' }] },
			});
			const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }));

			expect(await detector.hasAny('a', ['Cargo', 'LIBRARIAN'])).toBe(true);
		});

		it('returns false when none of the given names match', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'OAuth' }] },
			});
			const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }));

			expect(await detector.hasAny('a', ['Cargo', 'LIBRARIAN'])).toBe(false);
		});

		it('returns false on probe failure', async () => {
			vi.mocked(makeApiRequest).mockRejectedValueOnce(new Error('network down'));
			const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }));

			expect(await detector.hasAny('a', ['Cargo', 'LIBRARIAN'])).toBe(false);
		});

		it('returns false on an empty names list', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'Cargo' }] },
			});
			const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }));

			expect(await detector.hasAny('a', [])).toBe(false);
		});

		it('shares the same cache as has()', async () => {
			vi.mocked(makeApiRequest).mockResolvedValueOnce({
				query: { extensions: [{ name: 'LIBRARIAN' }] },
			});
			const detector = new ExtensionDetectorImpl(makeRegistry({ a: baseWiki }));

			expect(await detector.has('a', 'OAuth')).toBe(false);
			expect(await detector.hasAny('a', ['Cargo', 'LIBRARIAN'])).toBe(true);
			expect(vi.mocked(makeApiRequest)).toHaveBeenCalledTimes(1);
		});
	});
});
