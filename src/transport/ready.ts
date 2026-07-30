import type express from 'express';
import { recordReadyFailure } from '../runtime/metrics.ts';
import type { MwnProvider } from '../wikis/mwnProvider.ts';
import type { ActiveWiki } from '../wikis/activeWiki.ts';

interface ReadyCacheEntry {
	expiresAt: number;
	payload: { status: 'ready' | 'not_ready'; wiki: string; reason?: string; checked_at: string };
	httpStatus: 200 | 503;
}

const READY_CACHE_TTL_MS = 5_000;
// Exported so the probe tests can size their fixtures against the real budget.
export const READY_PROBE_TIMEOUT_MS = 3_000;
let readyCache: ReadyCacheEntry | null = null;
// The probe currently running, shared by every request that arrives while it is
// still going. The cache alone cannot do this: it only fills once a probe
// finishes, which is the whole window a slow wiki spends in.
let readyProbeInFlight: Promise<ReadyCacheEntry> | null = null;

export function __resetReadyCacheForTesting(): void {
	readyCache = null;
	readyProbeInFlight = null;
}

// Both halves of the check as one promise, so the race spans the whole of it:
// resolving the provider can log in, which alone can outlast the budget.
async function probeSiteInfo(mwnProvider: MwnProvider): Promise<void> {
	const mwn = await mwnProvider.get();
	await mwn.request({
		action: 'query',
		meta: 'siteinfo',
		format: 'json',
		siprop: 'general',
	});
}

async function probeDefaultWiki(
	activeWiki: ActiveWiki,
	mwnProvider: MwnProvider,
): Promise<ReadyCacheEntry> {
	const wiki = activeWiki.getDefaultKey();
	const checkedAt = new Date().toISOString();
	// Resolves rather than rejects, so arming it before the race cannot orphan a
	// rejection.
	const timedOut = Symbol('probe timed out');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof timedOut>((resolve) => {
		timer = setTimeout(() => resolve(timedOut), READY_PROBE_TIMEOUT_MS);
	});

	try {
		const outcome = await Promise.race([probeSiteInfo(mwnProvider), deadline]);
		if (outcome === timedOut) {
			throw new Error(`probe timeout after ${READY_PROBE_TIMEOUT_MS}ms`);
		}
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'ready', wiki, checked_at: checkedAt },
			httpStatus: 200,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'not_ready', wiki, reason, checked_at: checkedAt },
			httpStatus: 503,
		};
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

// Test seam: exported so the timeout test can call the probe directly,
// bypassing supertest's lazy request sending under vi.useFakeTimers.
export const __probeDefaultWikiForTesting = probeDefaultWiki;

export function mountReadyEndpoint(
	app: express.Express,
	deps: {
		activeWiki: ActiveWiki;
		mwnProvider: MwnProvider;
	},
): void {
	app.get('/ready', async (_req, res) => {
		let entry = readyCache;
		if (!entry || Date.now() >= entry.expiresAt) {
			if (readyProbeInFlight) {
				entry = await readyProbeInFlight;
			} else {
				const probe = probeDefaultWiki(deps.activeWiki, deps.mwnProvider);
				readyProbeInFlight = probe;
				try {
					entry = await probe;
				} finally {
					// Retire only our own probe. Nothing can replace it mid-flight
					// today, but clearing blind would discard a successor's.
					if (readyProbeInFlight === probe) {
						readyProbeInFlight = null;
					}
				}
				readyCache = entry;
				// Count distinct probe failures, not cached replays or the requests
				// that merely waited on this probe — K8s readiness probes that fire
				// every second would otherwise inflate the counter for one outage.
				if (entry.httpStatus !== 200) {
					recordReadyFailure();
				}
			}
		}
		res.status(entry.httpStatus).json(entry.payload);
	});
}
