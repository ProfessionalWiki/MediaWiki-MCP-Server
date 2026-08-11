import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/transport/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../../../src/transport/httpFetch.ts')>(
		'../../../../src/transport/httpFetch.ts',
	);
	return { ...actual, postForm: vi.fn() };
});

import { FetchError } from 'node-fetch';
import {
	FileTooLargeError,
	HttpStatusError,
	postForm,
} from '../../../../src/transport/httpFetch.ts';
import { runSparqlQuery, SparqlError } from '../../../../src/tools/extensions/wikibase/sparql.ts';
import { withRequestFields } from '../../../../src/runtime/requestContext.ts';

const ENDPOINT = 'https://query.example.org/sparql';
const CATS = 'SELECT ?item WHERE { ?item wdt:P31 wd:Q146 }';
const MANY_ROWS = 1000;

function selectResults(bindings: unknown[], vars: string[] = ['item']): string {
	return JSON.stringify({ head: { vars }, results: { bindings } });
}

function rowBindings(count: number): unknown[] {
	return Array.from({ length: count }, (_, i) => ({ item: { type: 'uri', value: `urn:${i}` } }));
}

async function failureOf(promise: Promise<unknown>): Promise<SparqlError> {
	const err = await promise.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(SparqlError);
	return err as SparqlError;
}

describe('runSparqlQuery', () => {
	beforeEach(() => {
		vi.mocked(postForm).mockReset();
	});

	it('asks the endpoint for SPARQL JSON results under a byte cap', async () => {
		vi.mocked(postForm).mockResolvedValue(selectResults(rowBindings(1)));

		await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS);

		expect(vi.mocked(postForm).mock.calls[0][0]).toBe(ENDPOINT);
		expect(vi.mocked(postForm).mock.calls[0][1]).toEqual({ query: CATS });
		const options = vi.mocked(postForm).mock.calls[0][2];
		expect(options).toMatchObject({ headers: { Accept: 'application/sparql-results+json' } });
		// The row cap only applies once the whole envelope is parsed, so this is
		// what stands between a missing LIMIT and the server's heap.
		expect(options?.maxBytes).toBe(10 * 1024 * 1024);
	});

	it('renders the bindings as pipe-separated rows in column order', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults(
				[
					{
						item: { type: 'uri', value: 'urn:cat' },
						itemLabel: { type: 'literal', value: 'Gli' },
					},
				],
				['item', 'itemLabel'],
			),
		);

		const results = await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS);

		expect(results).toMatchObject({
			columns: ['item', 'itemLabel'],
			rows: ['urn:cat | Gli'],
			totalRows: 1,
		});
	});

	it('leaves an unbound cell empty rather than dropping the column', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults([{ item: { type: 'uri', value: 'urn:x' } }], ['item', 'itemLabel']),
		);

		expect((await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS)).rows).toEqual(['urn:x | ']);
	});

	it('leaves a term without a string value as an empty cell', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults([{ item: { type: 'uri' }, itemLabel: { value: 42 } }], ['item', 'itemLabel']),
		);

		expect((await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS)).rows).toEqual([' | ']);
	});

	// GROUP_CONCAT with a newline separator is standard SPARQL, and a cell holding
	// one would otherwise break the one-line-per-solution contract.
	it('collapses line breaks inside a cell so one solution stays one line', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults([{ item: { type: 'literal', value: 'Gli\nRoma\r\nMuseo\rDoria' } }]),
		);

		expect((await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS)).rows).toEqual([
			'Gli Roma Museo Doria',
		]);
	});

	it('collapses line breaks in every cell, not only the first one it meets', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults(
				[
					{ item: { type: 'literal', value: 'a\nb' }, other: { type: 'literal', value: 'c\nd' } },
					{ item: { type: 'literal', value: 'e\nf' }, other: { type: 'literal', value: 'g\nh' } },
				],
				['item', 'other'],
			),
		);

		expect((await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS)).rows).toEqual([
			'a b | c d',
			'e f | g h',
		]);
	});

	it('renders only the rows the caller asked for, and reports how many matched', async () => {
		vi.mocked(postForm).mockResolvedValue(selectResults(rowBindings(500)));

		const results = await runSparqlQuery(ENDPOINT, CATS, 3);

		expect(results.rows).toEqual(['urn:0', 'urn:1', 'urn:2']);
		expect(results.totalRows).toBe(500);
	});

	it('reports an ASK result as a boolean', async () => {
		vi.mocked(postForm).mockResolvedValue(JSON.stringify({ head: {}, boolean: false }));

		expect(await runSparqlQuery(ENDPOINT, 'ASK {}', MANY_ROWS)).toMatchObject({ boolean: false });
	});

	it('cancels the query with the MCP request that asked for it', async () => {
		vi.mocked(postForm).mockResolvedValue(selectResults([]));
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, async () => {
			await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS);
		});

		const signal = vi.mocked(postForm).mock.calls[0][2]?.signal;
		expect(signal?.aborted).toBe(false);
		controller.abort();
		expect(signal?.aborted).toBe(true);
	});

	// A service that accepts the connection and then never answers rejects
	// nothing, so the timeout leg is the only thing that ends the call — and it
	// has to survive being composed with the request's own signal.
	it('cancels a query the service accepts and never answers', async () => {
		vi.mocked(postForm).mockResolvedValue(selectResults([]));
		const timeout = new AbortController();
		const armed = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
		const request = new AbortController();

		try {
			await withRequestFields({ signal: request.signal }, async () => {
				await runSparqlQuery(ENDPOINT, CATS, MANY_ROWS);
			});
		} finally {
			armed.mockRestore();
		}

		const signal = vi.mocked(postForm).mock.calls[0][2]?.signal;
		expect(signal?.aborted).toBe(false);
		timeout.abort();
		expect(signal?.aborted).toBe(true);
	});

	it('reports an aborted query as a timeout rather than an opaque failure', async () => {
		vi.mocked(postForm).mockRejectedValue(
			Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
		);

		const error = await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS));

		expect(error.category).toBe('upstream_failure');
		expect(error.message).toContain('60 seconds');
	});

	it('reports a timed-out query as a timeout', async () => {
		vi.mocked(postForm).mockRejectedValue(
			Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
		);

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).message).toContain(
			'60 seconds',
		);
	});

	it('maps a rejected query to invalid_input carrying the service message', async () => {
		vi.mocked(postForm).mockRejectedValue(
			new HttpStatusError(400, ENDPOINT, 'MalformedQueryException: Encountered "<EOF>"'),
		);

		const error = await failureOf(runSparqlQuery(ENDPOINT, 'SELECT ?x WHERE {', MANY_ROWS));

		expect(error.category).toBe('invalid_input');
		expect(error.message).toContain('MalformedQueryException');
	});

	it('maps an unauthenticated endpoint to authentication', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(401, ENDPOINT, 'Unauthorized'));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'authentication',
		);
	});

	it('maps a refused query to permission_denied', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(403, ENDPOINT, 'Forbidden'));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'permission_denied',
		);
	});

	it('maps a throttled endpoint to rate_limited', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(429, ENDPOINT, 'slow down'));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'rate_limited',
		);
	});

	it('maps a failing endpoint to upstream_failure', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(500, ENDPOINT, 'boom'));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	it('names the empty body when the endpoint rejects without one', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(500, ENDPOINT, ''));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).message).toContain(
			'HTTP 500',
		);
	});

	it('maps an unreachable endpoint to upstream_failure', async () => {
		vi.mocked(postForm).mockRejectedValue(new FetchError('request failed', 'system'));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	it('tells the caller to add LIMIT when the result set overruns the byte cap', async () => {
		vi.mocked(postForm).mockRejectedValue(new FileTooLargeError(20_000_000, 10_485_760));

		const error = await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS));

		// A caller query with no LIMIT is a client mistake, and only
		// upstream_failure is logged at level=error.
		expect(error.category).toBe('invalid_input');
		expect(error.message).toContain('LIMIT');
	});

	it('names the result cap it refused at', async () => {
		vi.mocked(postForm).mockRejectedValue(new FileTooLargeError(20_000_000, 10_485_760));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).message).toContain('10 MB');
	});

	// The endpoint is the operator's to know, and it can carry a token in its path
	// or query; a transport error quotes the URL it failed on.
	it('names the endpoint rather than quoting it back in an unclassified failure', async () => {
		const secret = 'https://query.example.org/sparql?token=hunter2';
		vi.mocked(postForm).mockRejectedValue(new Error(`request to ${secret} failed`));

		const error = await failureOf(runSparqlQuery(secret, CATS, MANY_ROWS));

		expect(error.message).toBe('request to the configured sparqlEndpoint failed');
	});

	// A query service that echoes the request URI into its error page hands the
	// token straight back, and the service message reaches the caller and the logs.
	it('names the endpoint rather than quoting it back in a service message', async () => {
		const secret = 'https://query.example.org/sparql?token=hunter2';
		vi.mocked(postForm).mockRejectedValue(
			new HttpStatusError(400, secret, `Bad Request: ${secret} rejected the query`),
		);

		const error = await failureOf(runSparqlQuery(secret, CATS, MANY_ROWS));

		expect(error.message).toBe('Bad Request: the configured sparqlEndpoint rejected the query');
	});

	// The padding puts the token inside the first five hundred characters and the
	// rest of the URL past them, so cutting before naming leaves half a token.
	it('names the endpoint before cutting the service message, not after', async () => {
		const secret = 'https://query.example.org/sparql?token=hunter2&format=json';
		vi.mocked(postForm).mockRejectedValue(
			new HttpStatusError(400, secret, `${'e'.repeat(450)} ${secret}`),
		);

		const error = await failureOf(runSparqlQuery(secret, CATS, MANY_ROWS));

		expect(error.message).toBe(`${'e'.repeat(450)} the configured sparqlEndpoint`);
	});

	it('summarises a multi-line service message at its first five lines', async () => {
		const body = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(400, ENDPOINT, body));

		const error = await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS));

		expect(error.message).toBe('line 1 line 2 line 3 line 4 line 5');
	});

	it('cuts an overlong service message at five hundred characters', async () => {
		vi.mocked(postForm).mockRejectedValue(new HttpStatusError(400, ENDPOINT, 'e'.repeat(600)));

		const error = await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS));

		expect(error.message).toBe(`${'e'.repeat(500)}…`);
	});

	it('reports a response that is not JSON at all as upstream_failure', async () => {
		vi.mocked(postForm).mockResolvedValue('<html>proxy error</html>');

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	it('reports JSON that is not a SPARQL result set as upstream_failure', async () => {
		vi.mocked(postForm).mockResolvedValue(JSON.stringify({ status: 'queued' }));

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	// The envelope is parsed outside the classifying catch, so anything it throws
	// that is not a SparqlError reaches the caller unclassified.
	it('reports a JSON body that is not an object as upstream_failure', async () => {
		vi.mocked(postForm).mockResolvedValue('null');

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	it('reports an envelope whose head vars are not an array as upstream_failure', async () => {
		vi.mocked(postForm).mockResolvedValue(
			JSON.stringify({ head: { vars: 'item' }, results: { bindings: [] } }),
		);

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});

	it('reports an envelope whose bindings are not an array as upstream_failure', async () => {
		vi.mocked(postForm).mockResolvedValue(
			JSON.stringify({ head: { vars: ['item'] }, results: { bindings: { item: {} } } }),
		);

		expect((await failureOf(runSparqlQuery(ENDPOINT, CATS, MANY_ROWS))).category).toBe(
			'upstream_failure',
		);
	});
});
