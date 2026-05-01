import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { bucketQuery } from '../../../../src/tools/extensions/bucket/bucket-query.js';
import { dispatch } from '../../../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess,
} from '../../../helpers/structuredResult.js';

// rawRequest is called with `{url, method, data, headers}` where `data` is a
// form-urlencoded string. Tests assert the rendered Lua chain by parsing the
// `query` field out of that body.
function renderedQuery(call: unknown[]): string {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test helper, narrows to the rawRequest call shape
	const opts = call[0] as { data: string };
	return new URLSearchParams(opts.data).get('query') ?? '';
}

function rawRequestMock(payload: unknown): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue({ data: payload });
}

describe('bucket-query', () => {
	it('forwards the query to action=bucket and returns array rows', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({
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

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/api.php');
		expect(call.method).toBe('POST');
		expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		const params = new URLSearchParams(call.data);
		expect(params.get('action')).toBe('bucket');
		expect(params.get('format')).toBe('json');
		expect(params.get('query')).toBe('bucket("drops").select("page_name","item").limit(500).run()');

		expect(result.structuredContent).toMatchObject({
			rows: [
				{ page_name: 'Bandos chestplate', item: 'Bandos chestplate' },
				{ page_name: 'Bandos tassets', item: 'Bandos tassets' },
			],
		});
	});

	it('maps {error: msg} to invalid_input with verbatim message', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({
				bucketQuery: '',
				error: 'Bucket Exchange does not exist.',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("Exchange").select("page_name").run()',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('Bucket Exchange does not exist.');
	});

	it('surfaces upstream errors as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockRejectedValue(new Error('Bucket timeout')),
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
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle({ query: 'bucket("drops").select("page_name").run()' }, ctx);

		expect(renderedQuery(mock.rawRequest.mock.calls[0])).toBe(
			'bucket("drops").select("page_name").limit(500).run()',
		);
	});

	it('injects user-supplied limit before .run()', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		expect(renderedQuery(mock.rawRequest.mock.calls[0])).toBe(
			'bucket("drops").select("page_name").limit(50).run()',
		);
	});

	it('injects .offset(M) when continueFrom is set, after .limit', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
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

		expect(renderedQuery(mock.rawRequest.mock.calls[0])).toBe(
			'bucket("drops").select("page_name").limit(50).offset(100).run()',
		);
	});

	it('does not inject .offset when continueFrom is omitted', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		expect(renderedQuery(mock.rawRequest.mock.calls[0])).not.toContain('.offset(');
	});

	it('matches a tolerant .run() at end of chain (whitespace, newline)', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
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

		for (const call of mock.rawRequest.mock.calls) {
			expect(renderedQuery(call)).toMatch(/\.limit\(10\)\.run\s*\(\s*\)\s*$/);
		}
	});

	it('rejects a query missing a trailing .run() with invalid_input', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			bucketQuery,
			ctx,
		)({
			query: 'bucket("drops").select("page_name")',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/query must end in \.run\(\)/);
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('rejects a non-integer continueFrom with invalid_input', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn() });
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
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('emits a more-available truncation when rows.length === effectiveLimit', async () => {
		const fullPage = Array.from({ length: 50 }, (_, i) => ({
			page_name: `Item ${i}`,
		}));
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: fullPage }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('Reason: more-available');
		expect(text).toContain('Param: continueFrom');
		expect(text).toContain('Value: 50');
	});

	it('continueFrom advances by rows.length on subsequent pages', async () => {
		const fullPage = Array.from({ length: 50 }, (_, i) => ({
			page_name: `Item ${i + 50}`,
		}));
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: fullPage }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{
				query: 'bucket("drops").select("page_name").run()',
				limit: 50,
				continueFrom: '50',
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Value: 100');
	});

	it('emits no truncation when rows.length < effectiveLimit', async () => {
		const partial = Array.from({ length: 3 }, (_, i) => ({
			page_name: `Item ${i}`,
		}));
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: partial }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()', limit: 50 },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
	});

	it('wraps a non-array bucket field as a single-row array', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({
				bucketQuery: '',
				bucket: { count: 42 },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{ query: 'bucket("drops").select(bucket.count("*")).run()' },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({
			rows: [{ count: 42 }],
		});
	});

	it('injects Authorization: Bearer header when the wiki uses OAuth2', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
			usingOAuth2: true,
			options: { apiUrl: 'https://test.wiki/w/api.php', OAuth2AccessToken: 'abc-token' },
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle({ query: 'bucket("drops").select("page_name").run()' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.rawRequest.mock.calls[0][0] as {
			headers: Record<string, string>;
		};
		expect(call.headers.Authorization).toBe('Bearer abc-token');
	});

	it('omits Authorization header when OAuth2 is not in use', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle({ query: 'bucket("drops").select("page_name").run()' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.rawRequest.mock.calls[0][0] as {
			headers: Record<string, string>;
		};
		expect(call.headers.Authorization).toBeUndefined();
	});

	it('keeps a user-supplied .limit(M) earlier in the chain — last-wins is Bucket-side', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '', bucket: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await bucketQuery.handle({ query: 'bucket("drops").limit(10).select("page_name").run()' }, ctx);

		expect(renderedQuery(mock.rawRequest.mock.calls[0])).toBe(
			'bucket("drops").limit(10).select("page_name").limit(500).run()',
		);
	});

	it('treats a missing bucket field as empty rows', async () => {
		const mock = createMockMwn({
			rawRequest: rawRequestMock({ bucketQuery: '' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await bucketQuery.handle(
			{ query: 'bucket("drops").select("page_name").run()' },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({ rows: [] });
	});
});
