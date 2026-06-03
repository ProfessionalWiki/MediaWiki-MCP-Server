import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import {
	neowikiRequest,
	neowikiErrorResult,
	NeoWikiApiError,
} from '../../../../src/tools/extensions/neowiki/neowikiRequest.js';

// Builds an axios-style rejection: a thrown error carrying `.response`.
function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

describe('neowikiRequest', () => {
	it('derives the REST base from apiUrl and sends a GET with query string', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { schemas: [], totalRows: 0 } }),
		});
		await neowikiRequest(mock as never, {
			method: 'GET',
			path: '/schemas',
			query: { limit: '500', offset: '0' },
		});
		const call = mock.rawRequest.mock.calls[0][0] as Record<string, unknown>;
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/schemas?limit=500&offset=0');
		expect(call.method).toBe('GET');
	});

	it('JSON-encodes a POST body and sets Content-Type', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: { rows: [] } }) });
		await neowikiRequest(mock as never, {
			method: 'POST',
			path: '/query/cypher',
			body: { cypher: 'RETURN 1' },
		});
		const call = mock.rawRequest.mock.calls[0][0] as Record<string, unknown>;
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/query/cypher');
		expect(call.method).toBe('POST');
		expect(call.data).toBe(JSON.stringify({ cypher: 'RETURN 1' }));
		expect((call.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('injects the bearer when using OAuth2, and omits it otherwise', async () => {
		const withTok = createMockMwn({
			usingOAuth2: true,
			options: { apiUrl: 'https://test.wiki/w/api.php', OAuth2AccessToken: 'tok' },
			rawRequest: vi.fn().mockResolvedValue({ data: {} }),
		});
		await neowikiRequest(withTok as never, { method: 'GET', path: '/schemas' });
		const h1 = (withTok.rawRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers;
		expect(h1.Authorization).toBe('Bearer tok');

		const noTok = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });
		await neowikiRequest(noTok as never, { method: 'GET', path: '/schemas' });
		const h2 = (noTok.rawRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers;
		expect(h2.Authorization).toBeUndefined();
	});

	it('maps an errorType envelope to the right category', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(422, { errorType: 'writeQueryRejected', message: 'Query is not read-only.' }),
				),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'POST', path: '/query/cypher', body: {} }),
		).rejects.toMatchObject({ category: 'invalid_input', message: 'Query is not read-only.' });
	});

	it('maps permission/rate/backend errorTypes', async () => {
		const cases: Array<[string, string]> = [
			['permissionDenied', 'permission_denied'],
			['rateLimitExceeded', 'rate_limited'],
			['backendUnavailable', 'upstream_failure'],
		];
		for (const [errorType, category] of cases) {
			const mock = createMockMwn({
				rawRequest: vi.fn().mockRejectedValue(httpError(500, { errorType, message: 'x' })),
			});
			await expect(
				neowikiRequest(mock as never, { method: 'POST', path: '/query/cypher', body: {} }),
			).rejects.toMatchObject({ category });
		}
	});

	it('maps a REST param-validation envelope to invalid_input with the English message', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(
				httpError(400, {
					error: 'parameter-validation-failed',
					messageTranslations: { en: 'The "schema" parameter must be set.' },
				}),
			),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/subject-labels' }),
		).rejects.toMatchObject({
			category: 'invalid_input',
			message: 'The "schema" parameter must be set.',
		});
	});

	it('maps a 404 to not_found', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(404, { error: 'not-found' })),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/schema/Nope' }),
		).rejects.toMatchObject({ category: 'not_found' });
	});

	it('sanitizes an internal-exception body to message only', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(
				httpError(500, {
					message: 'Error: Unsupported Cypher value type: DateTime',
					exception: { backtrace: ['secret/path.php:67'] },
				}),
			),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'POST', path: '/query/cypher', body: {} }),
		).rejects.toMatchObject({
			category: 'upstream_failure',
			message: 'Error: Unsupported Cypher value type: DateTime',
		});
	});

	it('neowikiErrorResult renders a NeoWikiApiError and re-throws others', () => {
		const ctx = fakeContext();
		const res = neowikiErrorResult(new NeoWikiApiError('not_found', 'gone'), ctx);
		expect(res.isError).toBe(true);
		expect(() => neowikiErrorResult(new Error('boom'), ctx)).toThrow('boom');
	});

	it('throws upstream_failure when apiUrl is not set', async () => {
		const mock = createMockMwn({ options: { apiUrl: '' } });
		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/schemas' }),
		).rejects.toMatchObject({ category: 'upstream_failure' });
	});

	it('falls back to upstream_failure for an unknown errorType', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockRejectedValue(httpError(500, { errorType: 'someFutureType', message: 'x' })),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'POST', path: '/query/cypher', body: {} }),
		).rejects.toMatchObject({ category: 'upstream_failure' });
	});
});
