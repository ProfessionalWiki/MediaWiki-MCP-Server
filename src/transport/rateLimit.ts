// Token-bucket rate limiting for tools/call on the HTTP transport, keyed on the
// authenticated caller. The reverse proxy the deployment guide asks for can
// limit by IP; only this server knows which signed-in user a request acts as,
// so per-caller fairness has to live here. Anonymous callers share one bucket:
// without a verified identity (and without trusting a spoofable
// X-Forwarded-For) there is nothing honest to key on, so that bucket is a flood
// backstop for the wiki, not fairness between anonymous callers.

import { monotonicNow } from '../runtime/clock.ts';

export interface RateLimitSettings {
	// Sustained tools/call per second per authenticated caller.
	ratePerSecond: number;
	// Bucket capacity per caller: how far a burst can run ahead of the
	// sustained rate.
	burst: number;
	// Sustained tools/call per second across ALL anonymous callers combined.
	// 0 leaves anonymous traffic unlimited while keyed callers stay limited.
	anonymousRatePerSecond: number;
	anonymousBurst: number;
}

export type RateLimitDecision =
	| { allowed: true }
	// `bucket` names which allowance refused, so the metric can tell a caller
	// hitting its own limit from one refused by the shared bucket.
	| { allowed: false; retryAfterSeconds: number; bucket: 'caller' | 'anonymous' };

export interface RateLimiter {
	// key identifies the authenticated caller; undefined means anonymous. cost is
	// how many tool calls the request carries: a JSON-RPC batch charges one token
	// per tools/call entry, so wrapping calls in an array buys nothing.
	take(key: string | undefined, cost?: number): RateLimitDecision;
}

interface Bucket {
	tokens: number;
	last: number;
}

// Bounds the keyed-bucket map. Keys exist only for verified subjects, so growth
// tracks real signed-in users — the cap is a backstop, not an expected ceiling.
const MAX_TRACKED_KEYS = 10_000;

// Retry-After must be a finite number of seconds. A directly-constructed
// settings object could carry a zero or negative rate, making the deficit
// division non-finite; clamp rather than emit an unparseable header value.
const MAX_RETRY_AFTER_SECONDS = 3600;

function refill(bucket: Bucket, ratePerSecond: number, burst: number, now: number): void {
	// Clamped so that a caller passing its own clock cannot be drained by one that
	// steps backwards. A refill only ever adds.
	const elapsedMs = Math.max(0, now - bucket.last);
	bucket.tokens = Math.min(burst, bucket.tokens + (elapsedMs / 1000) * ratePerSecond);
	bucket.last = now;
}

function retryAfterFor(deficit: number, ratePerSecond: number): number {
	const seconds = Math.ceil(deficit / ratePerSecond);
	if (!Number.isFinite(seconds)) {
		return MAX_RETRY_AFTER_SECONDS;
	}
	return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}

function takeFrom(
	bucket: Bucket,
	ratePerSecond: number,
	burst: number,
	now: number,
	cost: number,
	which: 'caller' | 'anonymous',
): RateLimitDecision {
	refill(bucket, ratePerSecond, burst, now);
	if (bucket.tokens >= cost) {
		bucket.tokens -= cost;
		return { allowed: true };
	}
	// A cost above `burst` can never be satisfied however long the caller waits,
	// so such a batch has to be split; the deficit still gives a truthful lower
	// bound. Nothing is consumed on a refusal.
	return {
		allowed: false,
		retryAfterSeconds: retryAfterFor(cost - bucket.tokens, ratePerSecond),
		bucket: which,
	};
}

export function createRateLimiter(
	settings: RateLimitSettings,
	now: () => number = monotonicNow,
): RateLimiter {
	const { ratePerSecond, burst, anonymousRatePerSecond, anonymousBurst } = settings;
	const buckets = new Map<string, Bucket>();
	const anonymous: Bucket = { tokens: anonymousBurst, last: now() };
	const anonymousLimited = anonymousRatePerSecond > 0;

	function takeAnonymous(at: number, cost: number): RateLimitDecision {
		if (!anonymousLimited) {
			return { allowed: true };
		}
		return takeFrom(anonymous, anonymousRatePerSecond, anonymousBurst, at, cost, 'anonymous');
	}

	// Evicts only buckets that have refilled to capacity: a full bucket is
	// indistinguishable from no bucket, so dropping it is lossless. A drained
	// bucket must survive eviction — recreating one hands its caller a fresh
	// burst, which is exactly what the refusal exists to withhold.
	function sweep(at: number): void {
		for (const [key, bucket] of buckets) {
			refill(bucket, ratePerSecond, burst, at);
			if (bucket.tokens >= burst) {
				buckets.delete(key);
			}
		}
	}

	return {
		take(key: string | undefined, cost = 1): RateLimitDecision {
			if (cost <= 0) {
				return { allowed: true };
			}
			const at = now();
			if (key === undefined) {
				return takeAnonymous(at, cost);
			}
			let bucket = buckets.get(key);
			if (!bucket) {
				if (buckets.size >= MAX_TRACKED_KEYS) {
					sweep(at);
					if (buckets.size >= MAX_TRACKED_KEYS) {
						// Every tracked bucket is mid-drain, so admitting this key would
						// mean growing the map without bound. Refuse rather than fall back
						// to the anonymous bucket, which passes everything when anonymous
						// limiting is switched off.
						return {
							allowed: false,
							retryAfterSeconds: retryAfterFor(burst, ratePerSecond),
							bucket: 'caller',
						};
					}
				}
				bucket = { tokens: burst, last: at };
				buckets.set(key, bucket);
			}
			return takeFrom(bucket, ratePerSecond, burst, at, cost, 'caller');
		},
	};
}
