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
			'bucket("drops").select("page_name","item").run()',
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
});
