// Token-bucket rate limiting for tools/call on the HTTP transport, keyed on the
// authenticated caller. The reverse proxy the deployment guide asks for can
// limit by IP; only this server knows which signed-in user a request acts as,
// so per-caller fairness has to live here. Anonymous callers share one bucket:
// without a verified identity (and without trusting a spoofable
// X-Forwarded-For) there is nothing honest to key on, so that bucket is a flood
// backstop for the wiki, not fairness between anonymous callers.

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

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
	// key identifies the authenticated caller; undefined means anonymous.
	take(key: string | undefined): RateLimitDecision;
}

interface Bucket {
	tokens: number;
	last: number;
}

// Bounds the keyed-bucket map. Keys exist only for verified subjects, so growth
// tracks real signed-in users — the cap is a backstop, not an expected ceiling.
const MAX_TRACKED_KEYS = 10_000;

function refill(bucket: Bucket, ratePerSecond: number, burst: number, now: number): void {
	bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.last) / 1000) * ratePerSecond);
	bucket.last = now;
}

function takeFrom(
	bucket: Bucket,
	ratePerSecond: number,
	burst: number,
	now: number,
): RateLimitDecision {
	refill(bucket, ratePerSecond, burst, now);
	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return { allowed: true };
	}
	return {
		allowed: false,
		retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerSecond)),
	};
}

export function createRateLimiter(
	settings: RateLimitSettings,
	now: () => number = Date.now,
): RateLimiter {
	const { ratePerSecond, burst, anonymousRatePerSecond, anonymousBurst } = settings;
	const buckets = new Map<string, Bucket>();
	const anonymous: Bucket = { tokens: anonymousBurst, last: now() };

	function takeAnonymous(at: number): RateLimitDecision {
		if (anonymousRatePerSecond <= 0) {
			return { allowed: true };
		}
		return takeFrom(anonymous, anonymousRatePerSecond, anonymousBurst, at);
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
		take(key: string | undefined): RateLimitDecision {
			const at = now();
			if (key === undefined) {
				return takeAnonymous(at);
			}
			let bucket = buckets.get(key);
			if (!bucket) {
				if (buckets.size >= MAX_TRACKED_KEYS) {
					sweep(at);
					if (buckets.size >= MAX_TRACKED_KEYS) {
						// Every tracked bucket is mid-drain. Overflow keys share the
						// anonymous bucket rather than growing the map or passing free:
						// memory stays bounded and the overflow caller is still limited.
						return takeAnonymous(at);
					}
				}
				bucket = { tokens: burst, last: at };
				buckets.set(key, bucket);
			}
			return takeFrom(bucket, ratePerSecond, burst, at);
		},
	};
}
