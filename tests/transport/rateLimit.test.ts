import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter, type RateLimitSettings } from '../../src/transport/rateLimit.ts';

const SETTINGS: RateLimitSettings = {
	ratePerSecond: 10,
	burst: 20,
	anonymousRatePerSecond: 50,
	anonymousBurst: 100,
};

// A controllable clock: the limiter reads time only through the injected now().
function makeClock(start = 0): {
	now: () => number;
	advance: (ms: number) => void;
	stepBack: (ms: number) => void;
} {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		// A host correcting its wall clock moves it backwards, which no amount of
		// waiting undoes.
		stepBack: (ms: number) => {
			t -= ms;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('createRateLimiter', () => {
	it('allows a burst up to capacity, then refuses', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		for (let i = 0; i < SETTINGS.burst; i++) {
			expect(limiter.take('user:a')).toEqual({ allowed: true });
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('refills at the sustained rate', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		for (let i = 0; i < SETTINGS.burst; i++) {
			limiter.take('user:a');
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
		// 100ms at 10/s refills exactly one token.
		clock.advance(100);
		expect(limiter.take('user:a')).toEqual({ allowed: true });
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('reports how long until a token refills', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, ratePerSecond: 0.5, burst: 1 }, clock.now);
		expect(limiter.take('user:a')).toEqual({ allowed: true });
		const refused = limiter.take('user:a');
		// One token at 0.5/s takes 2s to refill.
		expect(refused).toEqual({ allowed: false, retryAfterSeconds: 2, bucket: 'caller' });
	});

	it('never reports a zero-second retry', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, ratePerSecond: 1000, burst: 1 }, clock.now);
		limiter.take('user:a');
		const refused = limiter.take('user:a');
		expect(refused).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
	});

	it('keys callers independently', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		for (let i = 0; i < SETTINGS.burst; i++) {
			limiter.take('user:a');
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
		expect(limiter.take('user:b')).toEqual({ allowed: true });
	});

	it('caps a bucket at capacity regardless of idle time', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		limiter.take('user:a');
		// A long idle must not bank more than `burst` tokens.
		clock.advance(3_600_000);
		for (let i = 0; i < SETTINGS.burst; i++) {
			expect(limiter.take('user:a')).toEqual({ allowed: true });
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('leaves an allowance untouched when the clock steps backwards', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		for (let i = 0; i < 3; i++) {
			expect(limiter.take('user:a')).toEqual({ allowed: true });
		}
		// Eleven seconds of backwards step is far more traffic, at 10/s, than this
		// caller has spent: charging it would lock out a caller that has barely
		// started.
		clock.stepBack(11_000);
		for (let i = 0; i < SETTINGS.burst - 3; i++) {
			expect(limiter.take('user:a')).toEqual({ allowed: true });
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('leaves the shared allowance untouched when the clock steps backwards', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, anonymousBurst: 3 }, clock.now);
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		clock.stepBack(60_000);
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		expect(limiter.take(undefined)).toMatchObject({ allowed: false });
	});

	it('measures elapsed time monotonically, so a wall-clock jump earns no tokens', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		// 0.01/s puts a refilled token 100 seconds of real time away, so only a
		// clock jump could produce one within this test.
		const limiter = createRateLimiter({ ...SETTINGS, ratePerSecond: 0.01, burst: 1 });
		expect(limiter.take('user:a')).toEqual({ allowed: true });
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
		vi.setSystemTime(Date.now() + 3_600_000);
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('earns nothing from a clock that steps back and then returns', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, burst: 2 }, clock.now);
		limiter.take('user:a');
		limiter.take('user:a');
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
		// A correction backwards, a request arriving during the excursion, then the
		// re-sync that undoes it. No time passed, so the drained bucket has earned
		// nothing.
		clock.stepBack(10_000);
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
		clock.advance(10_000);
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('shares one bucket across all anonymous callers', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, anonymousBurst: 3 }, clock.now);
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		expect(limiter.take(undefined)).toEqual({ allowed: true });
		// The fourth anonymous request is refused no matter "who" sends it.
		expect(limiter.take(undefined)).toMatchObject({ allowed: false });
		// Keyed callers are unaffected by the drained anonymous bucket.
		expect(limiter.take('user:a')).toEqual({ allowed: true });
	});

	it('leaves anonymous traffic unlimited when its rate is 0', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(
			{ ...SETTINGS, anonymousRatePerSecond: 0, anonymousBurst: 1 },
			clock.now,
		);
		for (let i = 0; i < 500; i++) {
			expect(limiter.take(undefined)).toEqual({ allowed: true });
		}
		// Keyed limiting still applies.
		for (let i = 0; i < SETTINGS.burst; i++) {
			limiter.take('user:a');
		}
		expect(limiter.take('user:a')).toMatchObject({ allowed: false });
	});

	it('refuses an overflow key when every tracked bucket is mid-drain', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, burst: 1 }, clock.now);
		// Fill the tracked-key map with drained buckets (burst 1: one take drains).
		for (let i = 0; i < 10_000; i++) {
			limiter.take(`user:${i}`);
		}
		// The sweep frees nothing, so admitting this key would grow the map without
		// bound. It is refused rather than admitted.
		expect(limiter.take('user:overflow')).toMatchObject({ allowed: false });
	});

	it('refuses an overflow key even when anonymous traffic is unlimited', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(
			{ ...SETTINGS, burst: 1, anonymousRatePerSecond: 0, anonymousBurst: 1 },
			clock.now,
		);
		for (let i = 0; i < 10_000; i++) {
			limiter.take(`user:${i}`);
		}
		// Falling back to the anonymous bucket here would pass every overflow caller
		// free, since anonymous limiting is switched off.
		for (let i = 0; i < 5; i++) {
			expect(limiter.take('user:overflow')).toMatchObject({ allowed: false });
		}
		// Anonymous callers are still unlimited, as configured.
		expect(limiter.take(undefined)).toEqual({ allowed: true });
	});

	it('charges a multi-call cost in one take, and refuses when it does not fit', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		expect(limiter.take('user:a', 5)).toEqual({ allowed: true });
		// 20 burst - 5 spent = 15 left, so 16 does not fit and nothing is consumed.
		expect(limiter.take('user:a', 16)).toMatchObject({ allowed: false });
		expect(limiter.take('user:a', 15)).toEqual({ allowed: true });
		expect(limiter.take('user:a', 1)).toMatchObject({ allowed: false });
	});

	it('refuses a cost that can never fit the bucket, without consuming', () => {
		const clock = makeClock();
		const limiter = createRateLimiter(SETTINGS, clock.now);
		expect(limiter.take('user:a', SETTINGS.burst + 1)).toMatchObject({ allowed: false });
		// The oversized request spent nothing: the full burst is still available.
		for (let i = 0; i < SETTINGS.burst; i++) {
			expect(limiter.take('user:a')).toEqual({ allowed: true });
		}
	});

	it('reports which allowance refused', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, burst: 1, anonymousBurst: 1 }, clock.now);
		limiter.take('user:a');
		expect(limiter.take('user:a')).toMatchObject({ allowed: false, bucket: 'caller' });
		limiter.take(undefined);
		expect(limiter.take(undefined)).toMatchObject({ allowed: false, bucket: 'anonymous' });
	});

	it('evicts idle full buckets under cap pressure, so new callers still get their own bucket', () => {
		const clock = makeClock();
		const limiter = createRateLimiter({ ...SETTINGS, burst: 2 }, clock.now);
		for (let i = 0; i < 10_000; i++) {
			limiter.take(`user:${i}`);
		}
		// Let every bucket refill to capacity: the sweep may now drop them all.
		clock.advance(10_000);
		// The new key gets a real bucket with the full per-caller burst.
		expect(limiter.take('user:new')).toEqual({ allowed: true });
		expect(limiter.take('user:new')).toEqual({ allowed: true });
		expect(limiter.take('user:new')).toMatchObject({ allowed: false });
	});
});
