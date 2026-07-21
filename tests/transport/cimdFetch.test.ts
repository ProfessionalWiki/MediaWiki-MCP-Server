import { describe, it, expect, vi, beforeEach } from 'vitest';

// Held in top-level variables (like fetchMock below) rather than created inline
// in the vi.mock factory: a mock function referenced only through a dynamically
// re-imported module binding does not reliably share state with the instance
// cimdFetch.ts's static import resolves to, which let a consumed
// mockRejectedValueOnce leak into a later test's unrelated call.
const assertPublicDestinationMock = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
const buildPinnedAgentMock = vi.fn(() => undefined);
vi.mock('../../src/transport/ssrfGuard.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/ssrfGuard.js')>(
		'../../src/transport/ssrfGuard.js',
	);
	return {
		...actual,
		assertPublicDestination: (...a: Parameters<typeof actual.assertPublicDestination>) =>
			assertPublicDestinationMock(...a),
		buildPinnedAgent: (...a: Parameters<typeof actual.buildPinnedAgent>) =>
			buildPinnedAgentMock(...a),
	};
});
const fetchMock = vi.fn();
vi.mock('node-fetch', () => ({ default: (...a: unknown[]) => fetchMock(...a) }));

import { fetchCimdDocument, CimdFetchError } from '../../src/transport/cimdFetch.js';
import { SsrfValidationError } from '../../src/transport/ssrfGuard.js';

function bodyOf(text: string) {
	return (async function* () {
		yield Buffer.from(text);
	})();
}

describe('fetchCimdDocument', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		assertPublicDestinationMock.mockReset();
		assertPublicDestinationMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	});

	it('returns status/body/cacheControl for a 200', async () => {
		fetchMock.mockResolvedValue({
			status: 200,
			body: bodyOf('{"client_id":"x"}'),
			headers: { get: (h: string) => (h === 'cache-control' ? 'max-age=3600' : null) },
		});
		const r = await fetchCimdDocument('https://vscode.dev/c.json');
		expect(r).toEqual({ status: 200, body: '{"client_id":"x"}', cacheControl: 'max-age=3600' });
		expect(fetchMock.mock.calls[0][1]).toHaveProperty('agent');
		expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
	});

	it('does not follow redirects (passes redirect: manual)', async () => {
		fetchMock.mockResolvedValue({ status: 302, body: bodyOf(''), headers: { get: () => null } });
		const r = await fetchCimdDocument('https://vscode.dev/c.json');
		expect(r.status).toBe(302);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
	});

	it('rejects a non-https URL', async () => {
		await expect(fetchCimdDocument('http://vscode.dev/c.json')).rejects.toBeInstanceOf(
			CimdFetchError,
		);
	});

	it('rejects an over-cap body', async () => {
		fetchMock.mockResolvedValue({
			status: 200,
			body: bodyOf('x'.repeat(20)),
			headers: { get: () => null },
		});
		await expect(
			fetchCimdDocument('https://vscode.dev/c.json', { maxBytes: 8 }),
		).rejects.toBeInstanceOf(CimdFetchError);
	});

	it('wraps an SSRF rejection and never calls fetch', async () => {
		assertPublicDestinationMock.mockRejectedValueOnce(
			new SsrfValidationError('resolves to 127.0.0.1 (loopback)'),
		);
		await expect(fetchCimdDocument('https://evil.example/c.json')).rejects.toBeInstanceOf(
			CimdFetchError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('wraps a timeout/abort into CimdFetchError', async () => {
		fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
		await expect(
			fetchCimdDocument('https://vscode.dev/c.json', { timeoutMs: 1 }),
		).rejects.toBeInstanceOf(CimdFetchError);
	});
});
