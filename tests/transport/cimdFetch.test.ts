import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/transport/ssrfGuard.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/ssrfGuard.js')>(
		'../../src/transport/ssrfGuard.js',
	);
	return {
		...actual,
		assertPublicDestination: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
		buildPinnedAgent: vi.fn(() => undefined),
	};
});
const fetchMock = vi.fn();
vi.mock('node-fetch', () => ({ default: (...a: unknown[]) => fetchMock(...a) }));

import { fetchCimdDocument, CimdFetchError } from '../../src/transport/cimdFetch.js';

function bodyOf(text: string) {
	return (async function* () {
		yield Buffer.from(text);
	})();
}

describe('fetchCimdDocument', () => {
	beforeEach(() => fetchMock.mockReset());

	it('returns status/body/cacheControl for a 200', async () => {
		fetchMock.mockResolvedValue({
			status: 200,
			body: bodyOf('{"client_id":"x"}'),
			headers: { get: (h: string) => (h === 'cache-control' ? 'max-age=3600' : null) },
		});
		const r = await fetchCimdDocument('https://vscode.dev/c.json');
		expect(r).toEqual({ status: 200, body: '{"client_id":"x"}', cacheControl: 'max-age=3600' });
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
});
