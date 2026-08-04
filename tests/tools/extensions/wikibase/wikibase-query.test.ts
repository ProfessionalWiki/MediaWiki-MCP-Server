import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/transport/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../../../src/transport/httpFetch.ts')>(
		'../../../../src/transport/httpFetch.ts',
	);
	return { ...actual, postForm: vi.fn() };
});

import { postForm, HttpStatusError } from '../../../../src/transport/httpFetch.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseQuery } from '../../../../src/tools/extensions/wikibase/wikibase-query.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';

const ENDPOINT = 'https://query.example.org/sparql';
const CATS = 'SELECT ?item WHERE { ?item wdt:P31 wd:Q146 } LIMIT 3';

// A wiki with no endpoint never reaches the handler: the pack's wikiGate refuses
// it centrally, which tests/runtime/wikiCapability.test.ts covers.
function contextWithEndpoint(sparqlEndpoint: string = ENDPOINT) {
	const config = {
		sitename: 'Test',
		server: 'https://test.wiki',
		articlepath: '/wiki',
		scriptpath: '/w',
		sparqlEndpoint,
	};
	return fakeContext({
		activeWiki: {
			get: () => ({ key: 'test-wiki', config: config as never }),
			getDefaultKey: () => 'test-wiki',
		},
	});
}

function selectResults(bindings: unknown[], vars: string[] = ['item']): string {
	return JSON.stringify({ head: { vars }, results: { bindings } });
}

function rowResults(count: number, prefix = 'urn:'): string {
	return selectResults(
		Array.from({ length: count }, (_, i) => ({ item: { type: 'uri', value: `${prefix}${i}` } })),
	);
}

const ONE_CAT = selectResults([
	{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q28792126' } },
]);

describe('wikibase-query', () => {
	beforeEach(() => {
		vi.mocked(postForm).mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('posts the query to the wiki query service', async () => {
		vi.mocked(postForm).mockResolvedValue(ONE_CAT);
		const ctx = contextWithEndpoint();

		await wikibaseQuery.handle(toolArgs(wikibaseQuery, { query: CATS }), ctx);

		expect(vi.mocked(postForm).mock.calls[0][0]).toBe(ENDPOINT);
		expect(vi.mocked(postForm).mock.calls[0][1]).toEqual({ query: CATS });
	});

	it('returns the columns and rows of a SELECT', async () => {
		vi.mocked(postForm).mockResolvedValue(
			selectResults(
				[
					{
						item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q28792126' },
						itemLabel: { type: 'literal', value: 'Gli', 'xml:lang': 'en' },
					},
				],
				['item', 'itemLabel'],
			),
		);
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(toolArgs(wikibaseQuery, { query: CATS }), ctx);

		expect(assertStructuredData(result)).toMatchObject({
			columns: ['item', 'itemLabel'],
			rows: ['http://www.wikidata.org/entity/Q28792126 | Gli'],
		});
	});

	it('reports a true ASK result as a boolean', async () => {
		vi.mocked(postForm).mockResolvedValue(JSON.stringify({ head: {}, boolean: true }));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: 'ASK { wd:Q42 wdt:P31 wd:Q5 }' }),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({ boolean: true });
	});

	it('reports a false ASK result as a boolean rather than as no rows', async () => {
		vi.mocked(postForm).mockResolvedValue(JSON.stringify({ head: {}, boolean: false }));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: 'ASK { wd:Q42 wdt:P31 wd:Q146 }' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.boolean).toBe(false);
		expect(data.rows).toBeUndefined();
	});

	it('hands the query service failure category back to the caller', async () => {
		vi.mocked(postForm).mockRejectedValue(
			new HttpStatusError(400, ENDPOINT, 'MalformedQueryException: Encountered "<EOF>"'),
		);
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: 'SELECT ?x WHERE {' }),
			ctx,
		);

		expect(assertStructuredError(result, 'invalid_input').message).toContain(
			'MalformedQueryException',
		);
	});

	it('caps the rows returned and says how to page past the cap', async () => {
		vi.mocked(postForm).mockResolvedValue(rowResults(5));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: CATS, limit: 2 }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.rows).toHaveLength(2);
		expect(data.truncation).toMatchObject({
			reason: 'capped-no-continuation',
			limit: 2,
			itemNoun: 'rows',
		});
	});

	it('reports no truncation when the query matched exactly the requested rows', async () => {
		vi.mocked(postForm).mockResolvedValue(rowResults(2));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: CATS, limit: 2 }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.rows).toHaveLength(2);
		expect(data.truncation).toBeUndefined();
	});

	it('rejects a limit above the hard cap', () => {
		expect(() => toolArgs(wikibaseQuery, { query: CATS, limit: 5000 })).toThrow();
	});

	it('truncates the row block at the content byte cap', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '40');
		vi.mocked(postForm).mockResolvedValue(rowResults(20, 'urn:some-longer-value-'));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(toolArgs(wikibaseQuery, { query: CATS }), ctx);

		const data = assertStructuredData(result);
		expect((data.rows as string[]).length).toBeLessThan(20);
		expect(data.truncation).toMatchObject({ reason: 'content-truncated', itemNoun: 'rows' });
	});

	it('names the rows the row cap dropped when the byte cap fires as well', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '40');
		vi.mocked(postForm).mockResolvedValue(rowResults(20, 'urn:some-longer-value-'));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(
			toolArgs(wikibaseQuery, { query: CATS, limit: 5 }),
			ctx,
		);

		const hint = String(assertStructuredData(result).truncation.remedyHint);
		expect(hint).toContain('matched 20 rows');
		expect(hint).toContain('LIMIT and OFFSET');
	});

	it('leaves the byte-cap remedy alone when every matching row was requested', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '40');
		vi.mocked(postForm).mockResolvedValue(rowResults(20, 'urn:some-longer-value-'));
		const ctx = contextWithEndpoint();

		const result = await wikibaseQuery.handle(toolArgs(wikibaseQuery, { query: CATS }), ctx);

		expect(String(assertStructuredData(result).truncation.remedyHint)).not.toContain('matched');
	});
});
