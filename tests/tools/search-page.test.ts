import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { searchPage } from '../../src/tools/search-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import type { SiteInfo } from '../../src/wikis/siteInfoCache.ts';
import { toolArgs } from '../helpers/toolArgs.ts';

type SearchRow = {
	ns: number;
	title: string;
	pageid: number;
	size: number;
	snippet: string;
	timestamp: string;
};

function searchRow(overrides: Partial<SearchRow> = {}): SearchRow {
	return {
		ns: 0,
		title: 'Test Page',
		pageid: 1,
		size: 1,
		snippet: 's',
		timestamp: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

function mockSearchReturning(search: SearchRow[], warning?: string) {
	return createMockMwn({
		request: vi.fn().mockResolvedValue({
			query: { search },
			...(warning !== undefined ? { warnings: { search: { warnings: warning } } } : {}),
		}),
	});
}

// Returns the scope notice alone. Asserting against the whole payload would
// let a result row satisfy an assertion the notice was supposed to carry.
function scopeNotice(text: string): string {
	const marker = 'Scope notice:';
	expect(text).toContain(marker);
	// The formatter renders a short value inline and a long one as its own
	// block, so skip any leading newlines before taking the notice's one line.
	return text
		.slice(text.indexOf(marker) + marker.length)
		.replace(/^\n+/, '')
		.split('\n')[0]
		.trim();
}

// The search call is located by its own list parameter rather than by call
// index, so a test stays honest if the handler ever issues another request
// first.
function searchParams(mock: ReturnType<typeof createMockMwn>): Record<string, unknown> {
	const call = mock.request.mock.calls.find(
		(args: unknown[]) => (args[0] as Record<string, unknown>).list === 'search',
	);
	expect(call).toBeDefined();
	return call![0] as Record<string, unknown>;
}

describe('search-page', () => {
	it('returns full-text search results with snippets', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					search: [
						{
							ns: 0,
							title: 'Test Page',
							pageid: 1,
							size: 1234,
							snippet: 'matching <span class="searchmatch">text</span>',
							timestamp: '2026-01-01T00:00:00Z',
							wordcount: 80,
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle({ query: 'test query', limit: 10 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('- Title: Test Page');
		expect(text).toContain('  Page ID: 1');
		expect(text).toContain('  Snippet: matching <span class="searchmatch">text</span>');
		expect(text).toContain('  Size: 1234');
		expect(text).toContain('  Word count: 80');
		expect(text).toContain('  Timestamp: 2026-01-01T00:00:00Z');
		expect(text).toMatch(/URL: .*\/wiki\/Test_Page/);
		expect(text).not.toContain('Truncation:');
	});

	it('returns an empty array when no results found', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { search: [] },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle({ query: 'nonexistent' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Results: (none)');
	});

	it('returns error on failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(searchPage, ctx)({ query: 'test' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});

	it('attaches capped-no-continuation truncation when response.continue is present', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					search: [
						{
							ns: 0,
							title: 'Test Page',
							pageid: 1,
							size: 1,
							snippet: 's',
							timestamp: '2026-01-01T00:00:00Z',
						},
					],
				},
				continue: { sroffset: 10, continue: '-||' },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle({ query: 'test', limit: 10 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Reason: capped-no-continuation');
		expect(text).toContain('  Returned count: 1');
		expect(text).toContain('  Limit: 10');
		expect(text).toContain('  Item noun: matches');
	});

	it('omits truncation when response.continue is absent', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					search: [
						{
							ns: 0,
							title: 'A',
							pageid: 1,
							size: 1,
							snippet: 's',
							timestamp: '2026-01-01T00:00:00Z',
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle({ query: 'test', limit: 10 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
	});

	it('builds result URLs from the public siteinfo server', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockImplementation((params: { meta?: string }) => {
				if (params.meta === 'siteinfo') {
					return Promise.resolve({
						query: { general: { server: 'https://public.example', articlepath: '/wiki/$1' } },
					});
				}
				return Promise.resolve({
					query: {
						search: [
							{
								ns: 0,
								title: 'Test Page',
								pageid: 1,
								size: 1,
								snippet: 's',
								timestamp: '2026-01-01T00:00:00Z',
							},
						],
					},
				});
			}),
		});
		const emptyMap = new Map<string, SiteInfo>();
		const ctx = fakeContext({
			mwn: async () => mock as never,
			siteInfoCache: {
				get: (k: string) => emptyMap.get(k),
				set: (k: string, v: SiteInfo) => {
					emptyMap.set(k, v);
				},
				delete: (k: string) => {
					emptyMap.delete(k);
				},
			} as never,
		});

		const result = await searchPage.handle({ query: 'test', limit: 10 }, ctx);
		const text = assertStructuredSuccess(result);
		expect(text).toMatch(/URL: https:\/\/public\.example\/wiki\/Test_Page/);
	});

	it('uses the effective default limit in truncation when limit is not provided', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					search: [
						{
							ns: 0,
							title: 'A',
							pageid: 1,
							size: 1,
							snippet: 's',
							timestamp: '2026-01-01T00:00:00Z',
						},
					],
				},
				continue: { sroffset: 10 },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle({ query: 'test' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Limit: 10');
	});

	it('searches page content rather than titles', async () => {
		const mock = mockSearchReturning([]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await searchPage.handle(toolArgs(searchPage, { query: 'test' }), ctx);

		expect(searchParams(mock).srwhat).toBe('text');
	});

	it('omits srnamespace when the caller names no namespaces', async () => {
		const mock = mockSearchReturning([]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await searchPage.handle(toolArgs(searchPage, { query: 'test' }), ctx);

		const params = searchParams(mock);
		expect(params.srsearch).toBe('test');
		expect(params).not.toHaveProperty('srnamespace');
	});

	it('joins requested namespaces into a single srnamespace value', async () => {
		const mock = mockSearchReturning([]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await searchPage.handle(toolArgs(searchPage, { query: 'test', namespaces: [0, 4, 14] }), ctx);

		expect(searchParams(mock).srnamespace).toBe('0|4|14');
	});

	it('reports the namespace each result came from', async () => {
		const mock = mockSearchReturning([searchRow({ title: 'Help:Contents', ns: 12 })]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle(
			toolArgs(searchPage, { query: 'test', namespaces: [12] }),
			ctx,
		);

		expect(assertStructuredSuccess(result)).toContain('  Namespace: 12');
	});

	it('flags results that fall outside the requested namespaces', async () => {
		const mock = mockSearchReturning([searchRow({ title: 'Help:Contents', ns: 12 })]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle(
			toolArgs(searchPage, { query: 'Help:Contents', namespaces: [0] }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(scopeNotice(text)).toContain('results include 12');
	});

	it('omits the scope notice when every result is in a requested namespace', async () => {
		const mock = mockSearchReturning([searchRow({ title: 'Test Page', ns: 0 })]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle(
			toolArgs(searchPage, { query: 'test', namespaces: [0] }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('- Title: Test Page');
		expect(text).not.toContain('Scope notice:');
	});

	it('rejects an empty namespaces array rather than searching everywhere', () => {
		expect(() => toolArgs(searchPage, { query: 'test', namespaces: [] })).toThrow();
	});

	it('reports a namespace the wiki refused to search', async () => {
		const mock = mockSearchReturning(
			[searchRow({ ns: 0 })],
			'Unrecognized value for parameter "srnamespace": 9999',
		);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle(
			toolArgs(searchPage, { query: 'test', namespaces: [0, 9999] }),
			ctx,
		);

		expect(scopeNotice(assertStructuredSuccess(result))).toContain('9999');
	});

	it('omits the scope notice when the caller named no namespaces', async () => {
		const mock = mockSearchReturning([searchRow({ title: 'Help:Contents', ns: 12 })]);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await searchPage.handle(toolArgs(searchPage, { query: 'Help:Contents' }), ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('- Title: Help:Contents');
		expect(text).not.toContain('Scope notice:');
	});
});
