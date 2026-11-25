import { describe, it, expect } from 'vitest';
import { contextFailingWith, contextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { noSuchRestPathBody } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';
import { neowikiSparqlQuery } from '../../../../src/tools/extensions/neowiki/neowiki-sparql-query.ts';

function solutions(...names: string[]): unknown {
	return {
		head: { vars: ['name', 'born'] },
		results: {
			bindings: names.map((name) => ({
				name: { type: 'literal', value: name },
				born: { type: 'literal', value: '1815-12-10' },
			})),
		},
	};
}

describe('neowiki-sparql-query', () => {
	it("POSTs the query to NeoWiki's SPARQL endpoint", async () => {
		const { mock, ctx } = contextReturning(solutions());

		await neowikiSparqlQuery.handle({ query: 'SELECT ?name ?born WHERE {}' }, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/query/sparql');
		expect(request.method).toBe('POST');
		expect(request.body).toEqual({ query: 'SELECT ?name ?born WHERE {}' });
	});

	it('returns the solutions as rows in column order', async () => {
		const { ctx } = contextReturning(solutions('Ada'));

		const result = await neowikiSparqlQuery.handle({ query: 'SELECT ?name ?born WHERE {}' }, ctx);

		expect(result.structuredContent).toEqual({
			columns: ['name', 'born'],
			rows: ['Ada | 1815-12-10'],
		});
	});

	it("returns an ASK query's answer as a boolean", async () => {
		const { ctx } = contextReturning({ head: {}, boolean: true });

		const result = await neowikiSparqlQuery.handle({ query: 'ASK {}' }, ctx);

		expect(result.structuredContent).toEqual({ boolean: true });
	});

	it('returns no more rows than the limit, saying how many the query matched', async () => {
		const { ctx } = contextReturning(solutions('Ada', 'Grace'));

		const result = await neowikiSparqlQuery.handle(
			{ query: 'SELECT ?name ?born WHERE {}', limit: 1 },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({
			rows: ['Ada | 1815-12-10'],
			truncation: { reason: 'capped-no-continuation', returnedCount: 1 },
		});
	});

	it('says a wiki that cannot answer SPARQL queries has no SPARQL store', async () => {
		const { ctx } = contextFailingWith(404, noSuchRestPathBody);

		const result = await dispatch(neowikiSparqlQuery, ctx)({ query: 'ASK {}' });

		expect(assertStructuredError(result, 'invalid_input').message).toContain('SPARQL store');
	});

	it('reports a query the store rejects as invalid input', async () => {
		const { ctx } = contextFailingWith(400, {
			errorType: 'sparqlSyntaxError',
			message: 'Parse error at line 1',
		});

		const result = await dispatch(neowikiSparqlQuery, ctx)({ query: 'SELEKT' });

		assertStructuredError(result, 'invalid_input');
	});

	it('refuses a response that is not SPARQL results', async () => {
		const { ctx } = contextReturning({ rows: [] });

		const result = await dispatch(neowikiSparqlQuery, ctx)({ query: 'SELECT * WHERE {}' });

		assertStructuredError(result, 'upstream_failure');
	});
});
