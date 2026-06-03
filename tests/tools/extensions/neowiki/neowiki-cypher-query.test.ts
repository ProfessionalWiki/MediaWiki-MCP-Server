import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiCypherQuery } from '../../../../src/tools/extensions/neowiki/neowiki-cypher-query.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

describe('neowiki-cypher-query', () => {
	it('posts cypher + parameters and returns the result envelope', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: {
					columns: ['name'],
					rows: [{ name: 'ACME Inc' }],
					resultCount: 1,
					durationMs: 11,
					truncated: false,
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCypherQuery.handle(
			{ cypher: 'MATCH (s:Subject:Company) RETURN s.name AS name', parameters: { x: 1 } },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as { url: string; data: string };
		expect(call.url).toContain('/query/cypher');
		expect(JSON.parse(call.data)).toEqual({
			cypher: 'MATCH (s:Subject:Company) RETURN s.name AS name',
			parameters: { x: 1 },
		});
		expect(result.structuredContent).toMatchObject({
			columns: ['name'],
			rows: [{ name: 'ACME Inc' }],
		});
		expect(result.structuredContent).not.toHaveProperty('truncation');
	});

	it('omits parameters from the body when not provided', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockResolvedValue({ data: { columns: [], rows: [], resultCount: 0, truncated: false } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiCypherQuery.handle({ cypher: 'RETURN 1' }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as { data: string };
		expect(JSON.parse(call.data)).toEqual({ cypher: 'RETURN 1' });
	});

	it('emits a capped truncation when the server truncated the result', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: { columns: ['n'], rows: [{ n: 1 }], resultCount: 1, durationMs: 5, truncated: true },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCypherQuery.handle({ cypher: 'MATCH (s) RETURN s.name AS n' }, ctx);
		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'capped-no-continuation' },
		});
	});

	it('maps a writeQueryRejected error to invalid_input', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(422, { errorType: 'writeQueryRejected', message: 'Query is not read-only.' }),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCypherQuery.handle({ cypher: 'CREATE (x)' }, ctx);
		assertStructuredError(result, 'invalid_input');
	});
});
