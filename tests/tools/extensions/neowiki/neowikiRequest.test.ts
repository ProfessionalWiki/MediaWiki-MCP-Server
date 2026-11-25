import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { neowikiRequest } from '../../../../src/tools/extensions/neowiki/neowikiRequest.ts';
import { ClassifiedError } from '../../../../src/errors/classifyError.ts';
import { WikiTimeoutError } from '../../../../src/errors/wikiTimeoutError.ts';
import { rejectionOf } from '../../../helpers/rejectionOf.ts';
import { httpError, noSuchRestPathBody } from '../../../helpers/httpError.ts';

describe('neowikiRequest', () => {
	it('derives the REST base from apiUrl and sends a GET with query string', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { schemas: [], nextCursor: null } }),
		});
		await neowikiRequest(mock as never, {
			method: 'GET',
			path: '/schemas',
			query: { limit: '50', cursor: '1462' },
		});
		const call = mock.rawRequest.mock.calls[0][0] as Record<string, unknown>;
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/schemas?limit=50&cursor=1462');
		expect(call.method).toBe('GET');
	});

	it('lets an expired call budget through instead of relabelling it', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(new WikiTimeoutError(150_000, 'calling')),
		});

		const err = await rejectionOf(
			neowikiRequest(mock as never, { method: 'GET', path: '/schemas' }),
		);

		// Converted, the tool returns it as a RESULT the dispatcher never sees,
		// losing the code and the write caveat.
		expect(err).toBeInstanceOf(WikiTimeoutError);
		expect(err).not.toBeInstanceOf(ClassifiedError);
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

	it.each([
		['permissionDenied', 'permission_denied'],
		['rateLimitExceeded', 'rate_limited'],
		['backendUnavailable', 'upstream_failure'],
	])('maps the %s errorType to %s', async (errorType, category) => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(500, { errorType, message: 'x' })),
		});

		await expect(
			neowikiRequest(mock as never, { method: 'POST', path: '/query/cypher', body: {} }),
		).rejects.toMatchObject({ category });
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

	it("carries the English reason of a refused write that NeoWiki made through MediaWiki's action API", async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(
				httpError(400, {
					actionModuleErrorCode: 'neowiki-invalid-schema',
					messageTranslations: { en: 'Property "Founded" needs a type.' },
					errorKey: 'apierror-neowiki-invalid-schema',
					httpCode: 400,
					httpReason: 'Bad Request',
				}),
			),
		});

		await expect(
			neowikiRequest(mock as never, {
				method: 'PUT',
				path: '/schema/Company',
				body: {},
				csrf: true,
			}),
		).rejects.toMatchObject({
			category: 'invalid_input',
			message: 'Property "Founded" needs a type.',
		});
	});

	it('maps a read-denied envelope to permission_denied', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(403, { error: 'rest-read-denied', httpCode: 403, httpReason: 'Forbidden' }),
				),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/schemas' }),
		).rejects.toMatchObject({ category: 'permission_denied' });
	});

	it('records the HTTP status the wiki answered with', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(409, { status: 'error', message: 'taken' })),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'POST', path: '/subject', body: {} }),
		).rejects.toMatchObject({ upstreamStatus: 409 });
	});

	it('maps a refused write to invalid_input and carries its violations', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(
				httpError(422, {
					status: 'error',
					message: 'Validation failed',
					violations: [
						{
							propertyName: null,
							code: 'dependent-subject-without-host',
							args: [],
							severity: 'error',
							subjectId: 's1demo6sssssss1',
						},
					],
				}),
			),
		});
		const err = await rejectionOf(
			neowikiRequest(mock as never, { method: 'PUT', path: '/subject/s1', body: {}, csrf: true }),
		);
		expect(err).toMatchObject({ category: 'invalid_input' });
		expect((err as Error).message).toContain('dependent-subject-without-host');
		expect((err as Error).message).toContain('s1demo6sssssss1');
	});

	it('maps a 404 to not_found', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(404, { error: 'not-found' })),
		});
		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/schema/Nope' }),
		).rejects.toMatchObject({ category: 'not_found' });
	});

	it('reports an endpoint the wiki does not serve as invalid input, naming it', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(404, noSuchRestPathBody)),
		});

		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/subject-counts' }),
		).rejects.toMatchObject({
			category: 'invalid_input',
			message: expect.stringContaining('/subject-counts'),
		});
	});

	it('words an endpoint the wiki does not serve as the request asks', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(httpError(404, noSuchRestPathBody)),
		});

		await expect(
			neowikiRequest(mock as never, {
				method: 'POST',
				path: '/query/cypher',
				unavailable: 'The wiki has no Neo4j store.',
			}),
		).rejects.toMatchObject({ category: 'invalid_input', message: 'The wiki has no Neo4j store.' });
	});

	it('reads no more of an answer than the request caps it at', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });

		await neowikiRequest(mock as never, {
			method: 'POST',
			path: '/query/sparql',
			sizeCap: { bytes: 100, exceeded: 'Too much.' },
		});

		expect(mock.rawRequest.mock.calls[0][0]).toMatchObject({ maxContentLength: 100 });
	});

	it('words an answer past its cap as the request asks', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(new Error('maxContentLength size of 100 exceeded')),
		});

		await expect(
			neowikiRequest(mock as never, {
				method: 'POST',
				path: '/query/sparql',
				sizeCap: { bytes: 100, exceeded: 'Add LIMIT to the query.' },
			}),
		).rejects.toMatchObject({ category: 'invalid_input', message: 'Add LIMIT to the query.' });
	});

	it.each([
		['a REST envelope', { error: 'rest-badtoken', messageTranslations: { en: 'Invalid token.' } }],
		['a write envelope', { status: 'error', message: 'Invalid token.' }],
		['no body', ''],
	])('reads a refused sign-in with %s as authentication', async (_, body) => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockRejectedValue(httpError(401, body)) });

		await expect(
			neowikiRequest(mock as never, { method: 'GET', path: '/schemas' }),
		).rejects.toMatchObject({ category: 'authentication' });
	});

	it.each([
		[418, { status: 'error', message: 'No coffee.' }, 'invalid_input'],
		[
			503,
			{ error: 'readonly', messageTranslations: { en: 'The wiki is read-only.' } },
			'upstream_failure',
		],
		[502, '', 'upstream_failure'],
	])(
		'reads an unlisted HTTP %i by its class, whatever the body',
		async (status, body, category) => {
			const mock = createMockMwn({
				rawRequest: vi.fn().mockRejectedValue(httpError(status, body)),
			});

			await expect(
				neowikiRequest(mock as never, { method: 'GET', path: '/schemas' }),
			).rejects.toMatchObject({ category });
		},
	);

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

	it('sends a PUT to the right URL', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'updated', subjectId: 's1' } }),
		});
		await neowikiRequest(mock as never, {
			method: 'PUT',
			path: '/subject/s1',
			body: { label: 'X', statements: {} },
		});
		const call = mock.rawRequest.mock.calls[0][0] as Record<string, unknown>;
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1');
		expect(call.method).toBe('PUT');
	});

	it('sends a DELETE and tolerates an empty body', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: '' }) });
		const out = await neowikiRequest(mock as never, { method: 'DELETE', path: '/subject/s1' });
		const call = mock.rawRequest.mock.calls[0][0] as Record<string, unknown>;
		expect(call.method).toBe('DELETE');
		expect(out).toBe('');
	});

	it('injects X-CSRF-TOKEN when csrf is set, and omits it otherwise', async () => {
		const withCsrf = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('csrf-tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: {} }),
		});
		await neowikiRequest(withCsrf as never, { method: 'DELETE', path: '/subject/s1', csrf: true });
		const h1 = (withCsrf.rawRequest.mock.calls[0][0] as { headers: Record<string, string> })
			.headers;
		expect(h1['X-CSRF-TOKEN']).toBe('csrf-tok');
		expect(withCsrf.getCsrfToken).toHaveBeenCalledTimes(1);

		const noCsrf = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });
		await neowikiRequest(noCsrf as never, { method: 'GET', path: '/schemas' });
		const h2 = (noCsrf.rawRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers;
		expect(h2['X-CSRF-TOKEN']).toBeUndefined();
		expect(noCsrf.getCsrfToken).not.toHaveBeenCalled();
	});

	it.each([
		[400, 'invalid_input'],
		[403, 'permission_denied'],
		[404, 'not_found'],
		[409, 'conflict'],
		[429, 'rate_limited'],
		[500, 'upstream_failure'],
	])(
		'maps the write {status:error,message} envelope of an HTTP %i to %s',
		async (status, category) => {
			const mock = createMockMwn({
				rawRequest: vi
					.fn()
					.mockRejectedValue(httpError(status, { status: 'error', message: 'bad' })),
			});

			await expect(
				neowikiRequest(mock as never, { method: 'PUT', path: '/subject/s1', body: {}, csrf: true }),
			).rejects.toMatchObject({ category, message: 'bad' });
		},
	);
});
