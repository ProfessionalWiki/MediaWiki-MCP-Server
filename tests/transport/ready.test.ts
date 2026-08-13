import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchUnhandledRejections } from '../helpers/unhandledRejections.ts';

const mockRequest = vi.fn();

// mockActiveWiki and mockMwnProvider are passed explicitly to mountReadyEndpoint()
// (and __probeDefaultWikiForTesting) in each test: the tests build their own express
// app and these inline stubs drive the probe. streamableHttp.ts no longer runs any
// boot on import, so no module-level loadConfig/mwnProvider mock is needed.

import express from 'express';
import request from 'supertest';
import {
	mountReadyEndpoint,
	__resetReadyCacheForTesting,
	__probeDefaultWikiForTesting,
	READY_PROBE_TIMEOUT_MS,
} from '../../src/transport/ready.ts';
import type { ActiveWiki } from '../../src/wikis/activeWiki.ts';
import type { MwnProvider } from '../../src/wikis/mwnProvider.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';

const exampleWikiConfig: WikiConfig = {
	sitename: 'Example',
	server: 'https://example.org',
	articlepath: '/wiki',
	scriptpath: '/w',
};

const mockActiveWiki: ActiveWiki = {
	get: () => ({ key: 'example.org', config: exampleWikiConfig }),
	getDefaultKey: () => 'example.org',
};

const mockMwnProvider: MwnProvider = {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Mwn has 100+ methods; tests only use request().
	get: async () => ({ request: mockRequest }) as never,
	invalidate: () => {},
};

function makeApp() {
	const app = express();
	mountReadyEndpoint(app, { activeWiki: mockActiveWiki, mwnProvider: mockMwnProvider });
	return app;
}

// Resolving the wiki logs in and fetches site info, so it can outlast the
// deadline before mwn.request is reached.
function providerTaking(
	ms: number,
	settle: () => unknown = () => ({ request: mockRequest }),
): MwnProvider {
	return {
		get: async () => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Mwn has 100+ methods; tests only use request().
			return settle() as never;
		},
		invalidate: () => {},
	};
}

describe('/ready', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		__resetReadyCacheForTesting();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns 200 ready when the probe succeeds', async () => {
		mockRequest.mockResolvedValue({ query: { general: { sitename: 'X' } } });
		const res = await request(makeApp()).get('/ready');
		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ready');
		expect(res.body.wiki).toBe('example.org');
		expect(typeof res.body.checked_at).toBe('string');
	});

	it('returns 503 not_ready when the probe rejects', async () => {
		mockRequest.mockRejectedValue(new Error('connection refused'));
		const res = await request(makeApp()).get('/ready');
		expect(res.status).toBe(503);
		expect(res.body.status).toBe('not_ready');
		expect(res.body.reason).toContain('connection refused');
	});

	it('shares one probe between requests that arrive before the first finishes', async () => {
		// The cache only fills once a probe finishes, so without in-flight sharing
		// every request arriving during a slow probe starts another one. Slow here
		// means slower than the requests take to arrive, but well inside the budget.
		mockRequest.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve({ query: { general: {} } }), 50);
				}),
		);
		const app = makeApp();

		const responses = await Promise.all([
			request(app).get('/ready'),
			request(app).get('/ready'),
			request(app).get('/ready'),
		]);

		for (const res of responses) {
			expect(res.status).toBe(200);
		}
		expect(mockRequest).toHaveBeenCalledTimes(1);
	});

	it('caches the result for 5 seconds', async () => {
		vi.useFakeTimers();
		mockRequest.mockResolvedValue({ query: { general: {} } });
		const app = makeApp();

		await request(app).get('/ready');
		await request(app).get('/ready');
		expect(mockRequest).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(5001);
		await request(app).get('/ready');
		expect(mockRequest).toHaveBeenCalledTimes(2);
	});

	it('measures the cache TTL monotonically, so a wall-clock jump does not re-probe', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		mockRequest.mockResolvedValue({ query: { general: {} } });
		const app = makeApp();

		await request(app).get('/ready');
		// An hour of wall clock, well past the 5-second TTL, but no running time.
		vi.setSystemTime(Date.now() + 3_600_000);
		await request(app).get('/ready');

		expect(mockRequest).toHaveBeenCalledTimes(1);
	});

	it('times the probe out at 3 seconds', async () => {
		vi.useFakeTimers();
		mockRequest.mockReturnValue(new Promise(() => undefined));

		const probePromise = __probeDefaultWikiForTesting(mockActiveWiki, mockMwnProvider);
		await vi.advanceTimersByTimeAsync(3001);
		const entry = await probePromise;

		expect(entry.httpStatus).toBe(503);
		expect(entry.payload.status).toBe('not_ready');
		expect(entry.payload.reason).toMatch(/timeout/i);
	});

	it('times out while still resolving the wiki, without an orphan rejection', async () => {
		vi.useFakeTimers();
		const rejections = watchUnhandledRejections();
		mockRequest.mockResolvedValue({ query: { general: { sitename: 'X' } } });

		const probe = __probeDefaultWikiForTesting(mockActiveWiki, providerTaking(5_000));
		await vi.advanceTimersByTimeAsync(5001);
		const entry = await probe;

		expect(rejections.map(String)).toEqual([]);
		expect(entry.httpStatus).toBe(503);
		expect(entry.payload.status).toBe('not_ready');
		expect(entry.payload.reason).toMatch(/timeout/i);
	});

	it('stays quiet when resolving the wiki fails after the deadline has passed', async () => {
		vi.useFakeTimers();
		const rejections = watchUnhandledRejections();
		const provider = providerTaking(5_000, () => {
			throw new Error('login failed');
		});

		const probe = __probeDefaultWikiForTesting(mockActiveWiki, provider);
		// Past the deadline, then past the failure that lands after it.
		await vi.advanceTimersByTimeAsync(5001);
		const entry = await probe;

		expect(rejections.map(String)).toEqual([]);
		expect(entry.httpStatus).toBe(503);
		// The deadline answered, so the later login failure had no one waiting on it.
		expect(entry.payload.reason).toMatch(/timeout/i);
	});

	// Guards the shared budget rather than the crash: this is the case that fails
	// if the two halves are ever given a deadline each. Both delays are derived
	// from the real budget so that retuning it cannot quietly void the premise.
	it('spends one budget across resolving the wiki and the site-info request', async () => {
		vi.useFakeTimers();
		// Neither half exceeds the budget alone; together they do.
		const half = READY_PROBE_TIMEOUT_MS * 0.6;
		mockRequest.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, half)));

		const probe = __probeDefaultWikiForTesting(mockActiveWiki, providerTaking(half));
		await vi.advanceTimersByTimeAsync(READY_PROBE_TIMEOUT_MS * 2);
		const entry = await probe;

		expect(entry.httpStatus).toBe(503);
		expect(entry.payload.reason).toMatch(/timeout/i);
	});
});
