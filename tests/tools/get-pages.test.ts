import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { getPages, BatchContentFormat } from '../../src/tools/get-pages.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { SectionServiceImpl } from '../../src/services/sectionService.ts';
import {
	assertStructuredData,
	assertStructuredError,
	assertStructuredSuccess,
} from '../helpers/structuredResult.ts';

function massQueryPage(title: string, pageid: number, revid: number, content?: string) {
	return {
		pageid,
		title,
		revisions: [
			{
				revid,
				timestamp: '2026-04-01T00:00:00Z',
				slots: {
					main: {
						contentmodel: 'wikitext',
						...(content !== undefined ? { content } : {}),
					},
				},
			},
		],
	};
}

function massQueryResponse(options: {
	pages?: unknown[];
	redirects?: Array<{ from: string; to: string }>;
	normalized?: Array<{ from: string; to: string }>;
}): unknown[] {
	return [
		{
			query: {
				...(options.pages ? { pages: options.pages } : {}),
				...(options.redirects ? { redirects: options.redirects } : {}),
				...(options.normalized ? { normalized: options.normalized } : {}),
			},
		},
	];
}

function readPage(title: string, pageid: number, revid: number, content?: string) {
	return {
		pageid,
		title,
		revisions: [
			{
				revid,
				timestamp: '2026-04-01T00:00:00Z',
				contentmodel: 'wikitext',
				...(content !== undefined ? { content } : {}),
			},
		],
	};
}

describe('get-pages', () => {
	describe('validation', () => {
		it('empty titles array returns validation error', async () => {
			const ctx = fakeContext();
			const result = await getPages.handle(
				{
					titles: [],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('titles');
		});

		it('more than 50 titles returns validation error', async () => {
			const titles = Array.from({ length: 51 }, (_, i) => `T${i}`);
			const ctx = fakeContext();
			const result = await getPages.handle(
				{
					titles,
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('50');
		});

		it('content=none + metadata=false returns validation error', async () => {
			const ctx = fakeContext();
			const result = await getPages.handle(
				{
					titles: ['Foo'],
					content: BatchContentFormat.none,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('metadata must be true');
		});
	});

	describe('followRedirects=true (default, via massQuery)', () => {
		it('returns 3 pages in input order with a single massQuery call', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [
						massQueryPage('Module:Infobox/Person', 2, 102, 'B'),
						massQueryPage('Module:Infobox', 1, 101, 'A'),
						massQueryPage('Module:Infobox/Organization', 3, 103, 'C'),
					],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Module:Infobox', 'Module:Infobox/Person', 'Module:Infobox/Organization'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			expect(massQuery).toHaveBeenCalledTimes(1);
			expect(massQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'query',
					prop: 'revisions',
					redirects: true,
					formatversion: '2',
					rvslots: 'main',
				}),
				'titles',
			);

			assertStructuredSuccess(result);
			// Order preserved: input title order, regardless of API response order.
			const data = assertStructuredData(result);
			expect(data.pages.map((p: Record<string, unknown>) => p.title)).toEqual([
				'Module:Infobox',
				'Module:Infobox/Person',
				'Module:Infobox/Organization',
			]);
			// No requestedTitle when it equals the resolved title.
			for (const entry of data.pages as Record<string, unknown>[]) {
				expect(entry).not.toHaveProperty('requestedTitle');
			}
			expect(data.pages.map((p: Record<string, unknown>) => p.source)).toEqual(['A', 'B', 'C']);
			expect(data.missing).toBeUndefined();
		});

		it('mixed found + missing: emits found pages + missing array, no isError', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [
						massQueryPage('Found1', 1, 101, 'X'),
						{ pageid: 0, title: 'NotReal', missing: true },
						massQueryPage('Found2', 2, 102, 'Y'),
					],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Found1', 'NotReal', 'Found2'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			const data = assertStructuredData(result);
			expect(data.pages.map((p: Record<string, unknown>) => p.title)).toEqual(['Found1', 'Found2']);
			// No requestedTitle when it equals the resolved title.
			for (const entry of data.pages as Record<string, unknown>[]) {
				expect(entry).not.toHaveProperty('requestedTitle');
			}
			expect(text).toContain('Missing:\n- NotReal');
		});

		it('all missing: returns empty pages array + missing', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [
						{ pageid: 0, title: 'A', missing: true },
						{ pageid: 0, title: 'B', missing: true },
					],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['A', 'B'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('Pages: (none)');
			expect(text).toContain('Missing:\n- A\n- B');
		});

		it('metadata=true includes revision metadata on each entry', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Foo', 1, 101, 'body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Foo'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			// No requestedTitle when it equals the resolved title.
			expect(text).not.toContain('Requested title:');
			const data = assertStructuredData(result);
			expect(data.pages[0]).not.toHaveProperty('requestedTitle');
			expect(text).toContain('Page ID: 1');
			expect(text).toContain('Title: Foo');
			expect(text).toContain('Latest revision ID: 101');
			expect(text).toContain('Content model: wikitext');
			expect(text).toContain('Source: body');
			expect(text).not.toContain('Redirected from:');
		});

		it('content=none + metadata=true returns metadata only, no source', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Foo', 1, 101)],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Foo'],
					content: BatchContentFormat.none,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			const data = assertStructuredData(result);
			expect(data.pages).toHaveLength(1);
			// No requestedTitle when it equals the resolved title.
			expect(data.pages[0]).not.toHaveProperty('requestedTitle');
			expect(text).toContain('Page ID: 1');
			expect(text).not.toContain('Source:');
		});

		it('duplicate input titles emit page once', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Foo', 1, 101, 'body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Foo', 'Foo'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			assertStructuredSuccess(result);
			const data = assertStructuredData(result);
			expect(data.pages).toHaveLength(1);
			// No requestedTitle when it equals the resolved title.
			expect(data.pages[0]).not.toHaveProperty('requestedTitle');
		});

		it('mwn.massQuery throws → isError with wrapped message via dispatcher', async () => {
			const massQuery = vi.fn().mockRejectedValue(new Error('API error'));
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await dispatch(
				getPages,
				ctx,
			)({
				titles: ['Foo'],
				content: BatchContentFormat.source,
				metadata: false,
				followRedirects: true,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('Failed to retrieve pages');
			expect(envelope.message).toContain('API error');
		});

		it('redirect followed: entry has redirectedFrom and target title', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					redirects: [{ from: 'Src', to: 'Tgt' }],
					pages: [massQueryPage('Tgt', 42, 9001, 'target body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Src'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			// requestedTitle present because requested ('Src') differs from resolved ('Tgt').
			expect(text).toContain('Requested title: Src');
			expect(text).toContain('  Title: Tgt');
			expect(text).toContain('  Redirected from: Src');
			expect(text).toContain('  Source: target body');
			const data = assertStructuredData(result);
			expect(data.pages[0]).toHaveProperty('requestedTitle', 'Src');
			expect(data.pages[0]).toHaveProperty('redirectedFrom', 'Src');
		});

		it('normalization only: no redirectedFrom', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					normalized: [{ from: 'foo', to: 'Foo' }],
					pages: [massQueryPage('Foo', 1, 101, 'body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['foo'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			// requestedTitle present because requested ('foo') differs from resolved ('Foo').
			expect(text).toContain('Requested title: foo');
			expect(text).toContain('  Title: Foo');
			expect(text).not.toContain('Redirected from:');
			const data = assertStructuredData(result);
			expect(data.pages[0]).toHaveProperty('requestedTitle', 'foo');
			expect(data.pages[0]).not.toHaveProperty('redirectedFrom');
		});

		it('normalized-then-redirect chain: redirectedFrom is the requested title', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					normalized: [{ from: 'main page', to: 'Main Page' }],
					redirects: [{ from: 'Main Page', to: 'Target' }],
					pages: [massQueryPage('Target', 5, 500, 'target')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['main page'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			// requestedTitle present because requested ('main page') differs from resolved ('Target').
			expect(text).toContain('Requested title: main page');
			expect(text).toContain('  Title: Target');
			expect(text).toContain('  Redirected from: main page');
			const data = assertStructuredData(result);
			expect(data.pages[0]).toHaveProperty('requestedTitle', 'main page');
			expect(data.pages[0]).toHaveProperty('redirectedFrom', 'main page');
		});

		it('redirect to missing target: requested title reported as missing', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					redirects: [{ from: 'BrokenRedirect', to: 'Ghost' }],
					pages: [{ pageid: 0, title: 'Ghost', missing: true }],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['BrokenRedirect'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('Pages: (none)');
			expect(text).toContain('Missing:\n- BrokenRedirect');
		});

		it('two requested titles redirect to same target: emit once', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					redirects: [
						{ from: 'Alias1', to: 'Target' },
						{ from: 'Alias2', to: 'Target' },
					],
					pages: [massQueryPage('Target', 1, 101, 'body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Alias1', 'Alias2'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: true,
				},
				ctx,
			);

			assertStructuredSuccess(result);
			// One entry emitted; requestedTitle present because 'Alias1' differs from resolved 'Target'.
			const data = assertStructuredData(result);
			expect(data.pages).toHaveLength(1);
			expect(data.pages[0]).toHaveProperty('requestedTitle', 'Alias1');
		});
	});

	describe('followRedirects=false (via mwn.read)', () => {
		it('passes redirects: false to mwn.read and emits pseudo-page wikitext under requested title', async () => {
			const read = vi
				.fn()
				.mockResolvedValue([readPage('Main Page', 7, 700, '#REDIRECT [[Target]]')]);
			const mock = createMockMwn({ read });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Main Page'],
					content: BatchContentFormat.source,
					metadata: true,
					followRedirects: false,
				},
				ctx,
			);

			expect(read).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledWith(
				['Main Page'],
				expect.objectContaining({ redirects: false }),
			);

			const text = assertStructuredSuccess(result);
			// No requestedTitle when it equals the resolved title.
			expect(text).not.toContain('Requested title:');
			expect(text).toContain('Title: Main Page');
			expect(text).toContain('Source: #REDIRECT [[Target]]');
			expect(text).not.toContain('Redirected from:');
			const data = assertStructuredData(result);
			expect(data.pages[0]).not.toHaveProperty('requestedTitle');
		});

		it('mwn.read throws → isError with wrapped message via dispatcher', async () => {
			const read = vi.fn().mockRejectedValue(new Error('read error'));
			const mock = createMockMwn({ read });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await dispatch(
				getPages,
				ctx,
			)({
				titles: ['Foo'],
				content: BatchContentFormat.source,
				metadata: false,
				followRedirects: false,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('Failed to retrieve pages');
			expect(envelope.message).toContain('read error');
		});
	});

	describe('byte truncation', () => {
		it('truncates oversized content per page with a truncation field on the entry', async () => {
			const big = 'x'.repeat(100001);
			const small = 'tiny body';
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Big', 1, 10, big), massQueryPage('Small', 2, 20, small)],
				}),
			);
			const request = vi.fn().mockResolvedValueOnce({
				parse: { sections: [{ line: 'Overview', index: '1', level: '2' }] },
			});
			const mock = createMockMwn({ massQuery, request });
			const ctx = fakeContext({
				mwn: async () => mock as never,
				sections: new SectionServiceImpl(),
			});

			const result = await getPages.handle(
				{
					titles: ['Big', 'Small'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			// No requestedTitle when title equals the requested title; first field is pageId.
			// The blank line after the source is what separates it from the next field:
			// without it the wikitext runs straight into `Truncation:`, and a page whose
			// own text contains such a line would read as a field of this payload.
			expect(text).toMatch(/Page ID: 1[\s\S]*?Source:\n\nx{100000}\n\n {2}Truncation:/);
			expect(text).toContain('    Reason: content-truncated');
			expect(text).toContain('    Returned bytes: 100000');
			expect(text).toContain('    Total bytes: 100001');
			expect(text).toContain('    Item noun: wikitext');
			expect(text).toContain('    Tool name: get-pages');
			expect(text).toContain('    Sections:\n    - 0 (Lead)\n    - 1 (Overview)');
			// The first body reached the response budget, so the page after it is
			// named rather than returned.
			expect(text).not.toContain(`  Source: ${small}`);
			expect(text).toContain('Small');

			expect(request).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledWith(
				expect.objectContaining({
					page: 'Big',
					prop: 'sections',
				}),
			);
		});

		// A body at the budget ends the response, so only the first page can carry a
		// content-truncated marker and the outline behind it is fetched once.
		it('cuts only the first page and names the rest', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [
						massQueryPage('BigA', 1, 10, 'a'.repeat(120000)),
						massQueryPage('BigB', 2, 20, 'b'.repeat(70000)),
					],
				}),
			);
			const request = vi
				.fn()
				.mockResolvedValue({ parse: { sections: [{ line: 'H', index: '1' }] } });
			const mock = createMockMwn({ massQuery, request });
			const ctx = fakeContext({
				mwn: async () => mock as never,
				sections: new SectionServiceImpl(),
			});

			const result = await getPages.handle(
				{
					titles: ['BigA', 'BigB'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect((text.match(/Truncation:/g) ?? []).length).toBe(2);
			expect(text).toContain('  Reason: content-truncated');
			expect(text).toContain('  Reason: capped-no-continuation');
			expect(text).not.toContain('Title: BigB');
			expect(request).toHaveBeenCalledTimes(1);
		});

		it('does not emit a truncation for content at exactly the byte cap', async () => {
			const exact = 'y'.repeat(100000);
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Exact', 1, 10, exact)],
				}),
			);
			const request = vi.fn();
			const mock = createMockMwn({ massQuery, request });
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getPages.handle(
				{
					titles: ['Exact'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: true,
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).not.toContain('Truncation:');
			expect(request).not.toHaveBeenCalled();
		});
	});
});

// The byte budget was applied to each body independently, so a call for the
// maximum 50 titles could return 50 times it.
describe('get-pages response budget', () => {
	function pagesOfSize(sizes: number[]) {
		const massQuery = vi.fn().mockResolvedValue(
			massQueryResponse({
				pages: sizes.map((size, i) => massQueryPage(`P${i + 1}`, i + 1, 100 + i, 'x'.repeat(size))),
			}),
		);
		const request = vi.fn().mockResolvedValue({ parse: { sections: [] } });
		const mock = createMockMwn({ massQuery, request });
		return fakeContext({ mwn: async () => mock as never, sections: new SectionServiceImpl() });
	}

	async function read(ctx: ReturnType<typeof fakeContext>, titles: string[]) {
		return getPages.handle(
			{ titles, content: BatchContentFormat.source, metadata: false, followRedirects: true },
			ctx,
		);
	}

	it('returns every page when their bodies fit the budget together', async () => {
		const ctx = pagesOfSize([30000, 30000, 30000]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2', 'P3']));

		expect(text).toContain('Title: P3');
		expect(text).not.toContain('Truncation:');
	});

	it('omits whole pages once the budget is spent, and names them', async () => {
		const ctx = pagesOfSize([40000, 40000, 40000]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2', 'P3']));

		expect(text).toContain('Title: P1');
		expect(text).toContain('Title: P2');
		expect(text).not.toContain('Title: P3');
		expect(text).toContain('  Reason: capped-no-continuation');
		expect(text).toContain('  Item noun: pages');
		expect(text).toContain('P3');
	});

	// A page dropped for the budget is a different fact from a page the wiki does
	// not have, so it is not folded into `missing`.
	it('reports an omitted page apart from a missing one', async () => {
		const ctx = pagesOfSize([100000, 40000]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).not.toContain('Missing:');
		expect(text).toContain('  Reason: capped-no-continuation');
	});

	// One page larger than the whole budget still comes back, cut, rather than
	// being dropped for not fitting.
	it('keeps a first page that fills the budget by itself', async () => {
		const ctx = pagesOfSize([150000, 10]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).toContain('Title: P1');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).not.toContain('Title: P2');
	});
});
