import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRequest = vi.fn();

vi.mock('../../src/config/loadConfig.js', () => ({
	loadConfigFromFile: () => ({
		defaultWiki: 'example.org',
		wikis: {
			'example.org': {
				sitename: 'Example',
				server: 'https://example.org',
				articlepath: '/wiki',
				scriptpath: '/w',
				token: null,
				username: null,
				password: null,
			},
		},
		uploadDirs: [],
	}),
}));

vi.mock('../../src/wikis/mwnProvider.js', () => ({
	MwnProviderImpl: class {
		get = async () => ({ request: mockRequest });
		invalidate = () => {};
	},
}));

import express from 'express';
import request from 'supertest';
import {
	mountReadyEndpoint,
	__resetReadyCacheForTesting,
	__probeDefaultWikiForTesting,
} from '../../src/transport/streamableHttp.js';

const mockWikiSelection = {
	getCurrent: () => ({ key: 'example.org', config: {} }),
	setCurrent: () => {},
	reset: () => {},
};

const mockMwnProvider = {
	get: async () => ({ request: mockRequest }),
	invalidate: () => {},
};

function makeApp() {
	const app = express();
	mountReadyEndpoint(app, { wikiSelection: mockWikiSelection as never, mwnProvider: mockMwnProvider as never });
	return app;
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

	it('times the probe out at 3 seconds', async () => {
		vi.useFakeTimers();
		mockRequest.mockReturnValue(new Promise(() => undefined));

		const probePromise = __probeDefaultWikiForTesting(
			mockWikiSelection as never,
			mockMwnProvider as never,
		);
		await vi.advanceTimersByTimeAsync(3001);
		const entry = await probePromise;

		expect(entry.httpStatus).toBe(503);
		expect(entry.payload.status).toBe('not_ready');
		expect(entry.payload.reason).toMatch(/timeout/i);
	});
});
