import { describe, it, expect, vi, afterEach } from 'vitest';
import { SiteInfoCacheImpl, type SiteInfo } from '../../src/wikis/siteInfoCache.ts';
import { fakeClock } from '../helpers/fakeClock.ts';

const HOUR_MS = 60 * 60 * 1000;

const siteInfo: SiteInfo = {
	server: 'https://test.wiki',
	articlepath: '/wiki',
	contentNamespaces: [0, 120],
};

afterEach(() => {
	vi.useRealTimers();
});

describe('SiteInfoCacheImpl', () => {
	it('serves an entry for an hour, then reports it due for a refetch', () => {
		const clock = fakeClock();
		const cache = new SiteInfoCacheImpl(clock.now);
		cache.set('a', siteInfo);

		clock.advance(HOUR_MS - 1);
		expect(cache.get('a')).toEqual(siteInfo);

		clock.advance(2);
		expect(cache.get('a')).toBeUndefined();
	});

	it('measures its TTL monotonically, so a wall-clock jump does not expire an entry', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		// The production clock, not an injected one.
		const cache = new SiteInfoCacheImpl();
		cache.set('a', siteInfo);

		// Two hours of wall clock, past the one-hour TTL, but no running time.
		vi.setSystemTime(Date.now() + 2 * HOUR_MS);

		expect(cache.get('a')).toEqual(siteInfo);
	});
});
