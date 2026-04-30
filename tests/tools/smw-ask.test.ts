import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { smwAsk } from '../../src/tools/smw-ask.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('smw-ask', () => {
	it('calls action=ask with the user query and returns row-shaped results', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					results: {
						'Frank Lloyd Wright': {
							fulltext: 'Frank Lloyd Wright',
							fullurl: 'https://test.wiki/wiki/Frank_Lloyd_Wright',
							namespace: 0,
							exists: '1',
							displaytitle: '',
							printouts: {
								'Has occupation': ['Architect'],
								'Born in': ['1867'],
							},
						},
					},
					meta: {
						count: 1,
						hash: 'abc',
						offset: 0,
						source: '',
						time: '0.01',
					},
					printrequests: [],
					serializer: 'SMW\\Serializers\\QueryResultSerializer',
					version: 2,
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwAsk.handle(
			{ query: '[[Category:Person]][[Born in::>1900]]|?Has occupation|?Born in' },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Title: Frank Lloyd Wright');
		expect(text).toContain('Namespace: 0');
		expect(text).toContain('Has occupation:');
		expect(text).toContain('Architect');
		// pageid is not in the mock response (SMW's action=ask does not return it
		// by default), so the normalized row omits the pageId field.
		expect(text).not.toContain('Page ID:');

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'ask',
		});
		expect(mock.request.mock.calls[0][0].query).toContain('[[Category:Person]]');
	});

	it('maps query.errors[] to invalid_input with verbatim message', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					errors: ['Some parts of the query were not understood: [[Borked'],
					meta: { count: 0 },
					printrequests: [],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(smwAsk, ctx)({ query: '[[Borked' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('Some parts of the query were not understood: [[Borked');
	});

	it('returns empty rows on count=0 with no errors', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					results: {},
					meta: { count: 0 },
					printrequests: [],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwAsk.handle({ query: '[[Category:DoesNotExist]]' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
		expect(result.structuredContent).toMatchObject({ rows: [] });
	});

	it('schema-validated limit overrides any embedded |limit= in the query', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { results: {}, meta: { count: 0 }, printrequests: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwAsk.handle({ query: '[[Category:X]]|limit=10', limit: 50 }, ctx);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toMatch(/\|limit=50\b/);
		expect(sentQuery).not.toMatch(/\|limit=10\b/);
	});

	it('clamps an embedded |limit= above 500 to 500 when no schema limit is given', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { results: {}, meta: { count: 0 }, printrequests: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwAsk.handle({ query: '[[Category:X]]|limit=10000' }, ctx);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toMatch(/\|limit=500\b/);
		expect(sentQuery).not.toMatch(/\|limit=10000\b/);
	});

	it('defaults to limit=500 when no limit is supplied (matching the description cap)', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { results: {}, meta: { count: 0 }, printrequests: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwAsk.handle({ query: '[[Category:X]]' }, ctx);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toMatch(/\|limit=500\b/);
	});

	it('translates continueFrom to SMW |offset= in the query', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { results: {}, meta: { count: 0 }, printrequests: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwAsk.handle({ query: '[[Category:X]]', continueFrom: '40' }, ctx);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toMatch(/\|offset=40\b/);
	});

	it('attaches a more-available truncation when SMW indicates more results', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					results: {
						A: { fulltext: 'A', namespace: 0, printouts: {} },
					},
					meta: { count: 1, offset: 0 },
					printrequests: [],
				},
				'query-continue-offset': 1,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwAsk.handle({ query: '[[Category:X]]', limit: 1 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('Reason: more-available');
		expect(text).toContain('Param: continueFrom');
		expect(text).toContain('Value: 1');
	});

	it('omits empty printouts from a row', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					results: {
						X: {
							fulltext: 'X',
							namespace: 0,
							printouts: {
								'Has property': ['Value'],
								'Empty property': [],
							},
						},
					},
					meta: { count: 1 },
					printrequests: [],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwAsk.handle({ query: 'q' }, ctx);

		expect(result.structuredContent).toMatchObject({
			rows: [
				{
					title: 'X',
					namespace: 0,
					printouts: { 'Has property': ['Value'] },
				},
			],
		});
		const row = (result.structuredContent as { rows: { printouts: Record<string, unknown> }[] })
			.rows[0];
		expect(row.printouts).not.toHaveProperty('Empty property');
	});

	it('surfaces upstream errors as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('SMW timeout')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(smwAsk, ctx)({ query: '[[Category:X]]' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('SMW timeout');
	});
});
