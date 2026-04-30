import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { bucketQuery } from '../../src/tools/bucket-query.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('bucket-query', () => {
	it('forwards the query verbatim to action=bucket and returns array rows', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				bucketQuery: 'echo',
				bucket: [
					{ page_name: 'Bandos chestplate', item: 'Bandos chestplate' },
					{ page_name: 'Bandos tassets', item: 'Bandos tassets' },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name","item").run()' },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Bandos chestplate');
		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'bucket',
			format: 'json',
		});
		expect(mock.request.mock.calls[0][0].query).toBe(
			'bucket("drops").select("page_name","item").limit(500).run()',
		);
		expect(result.structuredContent).toMatchObject({
			rows: [
				{ page_name: 'Bandos chestplate', item: 'Bandos chestplate' },
				{ page_name: 'Bandos tassets', item: 'Bandos tassets' },
			],
		});
	});

	it('maps {error: msg} to invalid_input with verbatim message', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				error: "bucket 'doesnotexist' not found",
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("doesnotexist").select("page_name").run()',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain("bucket 'doesnotexist' not found");
	});

	it('surfaces upstream errors as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('Bucket timeout')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("drops").select("page_name").run()',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('Bucket timeout');
	});

	it('injects .limit(500) before .run() when no limit param is given', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle({ query: 'bucket("drops").select("page_name").run()' }, ctx);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toBe('bucket("drops").select("page_name").limit(500).run()');
	});

	it('injects user-supplied limit before .run()', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toBe('bucket("drops").select("page_name").limit(50).run()');
	});

	it('injects .offset(M) when continueFrom is set, after .limit', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle(
			{
				query: 'bucket("drops").select("page_name").run()',
				limit: 50,
				continueFrom: '100',
			},
			ctx,
		);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).toBe('bucket("drops").select("page_name").limit(50).offset(100).run()');
	});

	it('does not inject .offset when continueFrom is omitted', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		const sentQuery = mock.request.mock.calls[0][0].query;
		expect(sentQuery).not.toContain('.offset(');
	});

	it('matches a tolerant .run() at end of chain (whitespace, newline)', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const variants = [
			'bucket("drops").select("page_name").run()',
			'bucket("drops").select("page_name").run( )',
			'bucket("drops").select("page_name"). run ( )',
			'bucket("drops").select("page_name").run()\n',
		];
		for (const query of variants) {
			await bucketQuery.handle({ query, limit: 10 }, ctx);
		}

		for (const call of mock.request.mock.calls) {
			expect(call[0].query).toMatch(/\.limit\(10\)\.run\s*\(\s*\)\s*$/);
		}
	});

	it('rejects a query missing a trailing .run() with invalid_input', async () => {
		const mock = createMockMwn({ request: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("drops").select("page_name")',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/query must end in \.run\(\)/);
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('rejects a non-integer continueFrom with invalid_input', async () => {
		const mock = createMockMwn({ request: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("drops").select("page_name").run()',
			continueFrom: 'not-a-number',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/continueFrom/);
		expect(mock.request).not.toHaveBeenCalled();
	});
});
