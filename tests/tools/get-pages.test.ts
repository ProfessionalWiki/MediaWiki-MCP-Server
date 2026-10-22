import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext, contextOn } from '../helpers/fakeContext.ts';
import { wikiAnswering } from '../helpers/wikiAnswering.ts';
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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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

		it("fails with the wiki's refusal instead of reporting the pages missing", async () => {
			const wiki = wikiAnswering({
				error: { code: 'readapidenied', info: 'You need read permission to use this module.' },
			});

			const result = await dispatch(
				getPages,
				contextOn(wiki.mwn),
			)({
				titles: ['Foo'],
				content: BatchContentFormat.source,
				metadata: false,
				followRedirects: true,
			});

			assertStructuredError(result, 'permission_denied', 'readapidenied');
		});

		it('redirect followed: entry has redirectedFrom and target title', async () => {
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					redirects: [{ from: 'Src', to: 'Tgt' }],
					pages: [massQueryPage('Tgt', 42, 9001, 'target body')],
				}),
			);
			const mock = createMockMwn({ massQuery });
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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
			const ctx = contextOn(mock);

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

	describe('followRedirects=false', () => {
		it('returns a redirect page as itself, without asking the wiki to follow it', async () => {
			const wiki = wikiAnswering({
				query: { pages: [massQueryPage('Old Name', 7, 700, '#REDIRECT [[New Name]]')] },
			});

			const result = await getPages.handle(
				{
					titles: ['Old Name'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: false,
				},
				contextOn(wiki.mwn),
			);

			expect(wiki.sentQuery().has('redirects')).toBe(false);
			const data = assertStructuredData(result);
			expect(data.pages[0]).toMatchObject({
				title: 'Old Name',
				source: '#REDIRECT [[New Name]]',
			});
			expect(data.pages[0]).not.toHaveProperty('redirectedFrom');
		});

		it('returns a page asked for by a non-canonical title', async () => {
			const wiki = wikiAnswering({
				query: {
					normalized: [{ from: 'main_Page', to: 'Main Page' }],
					pages: [massQueryPage('Main Page', 7, 700, 'Welcome')],
				},
			});

			const result = await getPages.handle(
				{
					titles: ['main_Page'],
					content: BatchContentFormat.source,
					metadata: false,
					followRedirects: false,
				},
				contextOn(wiki.mwn),
			);

			const data = assertStructuredData(result);
			expect(data.pages[0]).toMatchObject({
				title: 'Main Page',
				requestedTitle: 'main_Page',
				source: 'Welcome',
			});
			expect(data).not.toHaveProperty('missing');
		});
	});

	describe('byte truncation', () => {
		it('cuts a body that fills the budget and marks it on the entry', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
			const big = 'x'.repeat(1001);
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
			const ctx = contextOn(mock, {
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
			expect(text).toMatch(/Page ID: 1[\s\S]*?Source:\n\nx{1000}\n\n {2}Truncation:/);
			expect(text).toContain('    Reason: content-truncated');
			expect(text).toContain('    Returned bytes: 1000');
			expect(text).toContain('    Total bytes: 1001');
			expect(text).toContain('    Item noun: wikitext');
			expect(text).toContain('    Tool name: get-pages');
			expect(text).toContain('    Sections:\n    - 0 (Lead)\n    - 1 (Overview)');
			// The first body reached the response budget, so the page after it is
			// named rather than returned.
			expect(text).not.toContain(`  Source: ${small}`);
			expect(text).toContain('    Value: Small');

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
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [
						massQueryPage('BigA', 1, 10, 'a'.repeat(1200)),
						massQueryPage('BigB', 2, 20, 'b'.repeat(1200)),
					],
				}),
			);
			const request = vi
				.fn()
				.mockResolvedValue({ parse: { sections: [{ line: 'H', index: '1' }] } });
			const mock = createMockMwn({ massQuery, request });
			const ctx = contextOn(mock, {
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
			expect(text).toContain('  Reason: more-available');
			expect(text).not.toContain('Title: BigB');
			expect(request).toHaveBeenCalledTimes(1);
		});

		it('does not emit a truncation for content at exactly the byte cap', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
			const exact = 'y'.repeat(1000);
			const massQuery = vi.fn().mockResolvedValue(
				massQueryResponse({
					pages: [massQueryPage('Exact', 1, 10, exact)],
				}),
			);
			const request = vi.fn();
			const mock = createMockMwn({ massQuery, request });
			const ctx = contextOn(mock);

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
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// A small budget makes the boundaries legible and pins that it is read per
	// call rather than at module load.
	function pagesOfSize(sizes: (number | undefined)[], budget = '1000') {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', budget);
		const massQuery = vi.fn().mockResolvedValue(
			massQueryResponse({
				pages: sizes.map((size, i) =>
					massQueryPage(
						`P${i + 1}`,
						i + 1,
						100 + i,
						size === undefined ? undefined : 'x'.repeat(size),
					),
				),
			}),
		);
		const request = vi.fn().mockResolvedValue({ parse: { sections: [] } });
		const mock = createMockMwn({ massQuery, request });
		return contextOn(mock, { sections: new SectionServiceImpl() });
	}

	async function read(ctx: ReturnType<typeof fakeContext>, titles: string[]) {
		return getPages.handle(
			{ titles, content: BatchContentFormat.source, metadata: false, followRedirects: true },
			ctx,
		);
	}

	it('returns every page when their bodies fit the budget together', async () => {
		const ctx = pagesOfSize([300, 300, 300]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2', 'P3']));

		expect(text).toContain('Title: P3');
		expect(text).not.toContain('Truncation:');
	});

	it('keeps a page that exactly fills the remaining budget', async () => {
		const ctx = pagesOfSize([600, 400]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).toContain('Title: P2');
		expect(text).not.toContain('Truncation:');
	});

	it('omits whole pages once the budget is spent, and names them as a continuation', async () => {
		const ctx = pagesOfSize([400, 400, 400]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2', 'P3']));

		expect(text).toContain('Title: P1');
		expect(text).toContain('Title: P2');
		expect(text).not.toContain('Title: P3');
		expect(text).toContain('  Reason: more-available');
		expect(text).toContain('  Returned count: 2');
		expect(text).toContain('  Item noun: pages');
		expect(text).toContain('    Param: titles');
		expect(text).toContain('    Value: P3');
	});

	// A page the wiki does not have and a page left out for the budget are
	// different facts, and each has its own channel.
	it('reports a missing page and an omitted page through their own channels', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
		const massQuery = vi.fn().mockResolvedValue(
			massQueryResponse({
				pages: [
					massQueryPage('P1', 1, 100, 'x'.repeat(900)),
					{ title: 'Gone', missing: true },
					massQueryPage('P3', 3, 300, 'x'.repeat(900)),
				],
			}),
		);
		const request = vi.fn().mockResolvedValue({ parse: { sections: [] } });
		const mock = createMockMwn({ massQuery, request });
		const ctx = contextOn(mock, { sections: new SectionServiceImpl() });

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'Gone', 'P3']));

		expect(text).toContain('Missing:\n- Gone');
		expect(text).toContain('    Value: P3');
		expect(text).not.toContain('Title: P3');
	});

	// One page larger than the whole budget still comes back, cut, rather than
	// being dropped for not fitting.
	it('keeps a first page that fills the budget by itself', async () => {
		const ctx = pagesOfSize([1500, 10]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).toContain('Title: P1');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).not.toContain('Title: P2');
	});

	it('names a later page larger than the budget rather than cutting it', async () => {
		const ctx = pagesOfSize([300, 1500]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).not.toContain('Title: P2');
		expect(text).toContain('    Value: P2');
	});

	// An earlier entry can carry no body at all — a revision whose text the wiki
	// withholds — and dropping the first real one would answer a request for
	// source with no source anywhere in the response.
	it('cuts the first page that has a body, not the first page', async () => {
		const ctx = pagesOfSize([undefined, 1500]);

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'P2']));

		expect(text).toContain('Title: P2');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).toMatch(/Source:\n\nx{1000}/);
	});

	// A page asked for by a redirect or an unnormalised title must come back
	// under the name the caller used, or it cannot account for what it asked for.
	it('names an omitted page the way the caller named it', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
		const massQuery = vi.fn().mockResolvedValue(
			massQueryResponse({
				pages: [
					massQueryPage('P1', 1, 100, 'x'.repeat(900)),
					massQueryPage('Target', 2, 200, 'x'.repeat(900)),
				],
				redirects: [{ from: 'Shortcut', to: 'Target' }],
			}),
		);
		const request = vi.fn().mockResolvedValue({ parse: { sections: [] } });
		const mock = createMockMwn({ massQuery, request });
		const ctx = contextOn(mock, { sections: new SectionServiceImpl() });

		const text = assertStructuredSuccess(await read(ctx, ['P1', 'Shortcut']));

		expect(text).toContain('    Value: Shortcut');
	});

	it('outlines the page a redirect led to when cutting it', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
		const massQuery = vi.fn().mockResolvedValue(
			massQueryResponse({
				pages: [massQueryPage('Target', 1, 100, 'x'.repeat(1500))],
				redirects: [{ from: 'Shortcut', to: 'Target' }],
			}),
		);
		const request = vi.fn().mockResolvedValue({ parse: { sections: [] } });
		const mock = createMockMwn({ massQuery, request });
		const ctx = contextOn(mock, { sections: new SectionServiceImpl() });

		await read(ctx, ['Shortcut']);

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ page: 'Target', prop: 'sections' }),
		);
	});
});
