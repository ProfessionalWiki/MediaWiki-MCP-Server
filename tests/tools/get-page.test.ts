import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { getPage } from '../../src/tools/get-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { ContentFormat } from '../../src/results/contentFormat.ts';
import { SectionServiceImpl } from '../../src/services/sectionService.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import type { SiteInfo } from '../../src/wikis/siteInfoCache.ts';

describe('get-page', () => {
	it('returns page source using mwn.read()', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Test Page',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
						content: 'Hello world',
					},
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.source,
				metadata: false,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Source: Hello world');
		expect(text).not.toContain('Page ID:');
		expect(text).not.toContain('Title:');
		expect(mock.read).toHaveBeenCalledWith('Test Page', expect.any(Object));
	});

	it('returns HTML using action=parse', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>Hello</p>' },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.html,
				metadata: false,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('HTML: <p>Hello</p>');
	});

	it('returns metadata without content for ContentFormat.none', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Test Page',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
					},
				],
			}),
			request: vi.fn().mockResolvedValue({ parse: { sections: [] } }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.none,
				metadata: true,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Page ID: 1');
		expect(text).toContain('Title: Test Page');
		expect(text).toContain('Latest revision ID: 42');
		expect(text).toContain('Content model: wikitext');
		expect(text).not.toContain('Source:');
		expect(text).not.toContain('HTML:');
	});

	it('returns error when page is missing', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 0,
				title: 'Missing Page',
				missing: true,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Missing Page',
				content: ContentFormat.source,
				metadata: false,
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('returns both metadata and source when both requested', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Test Page',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
						content: 'Hello world',
					},
				],
			}),
			request: vi.fn().mockResolvedValue({ parse: { sections: [] } }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.source,
				metadata: true,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Page ID: 1');
		expect(text).toContain('Source: Hello world');
	});

	it('returns error on mwn failure via dispatcher', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			getPage,
			ctx,
		)({
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: false,
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});

	it('forwards section as rvsection for source content', async () => {
		const read = vi.fn().mockResolvedValue({
			pageid: 1,
			title: 'Test Page',
			revisions: [
				{
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: 'Section body',
				},
			],
		});
		const mock = createMockMwn({ read });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.source,
				metadata: false,
				section: 2,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Source: Section body');
		expect(read).toHaveBeenCalledWith(
			'Test Page',
			expect.objectContaining({
				rvsection: 2,
			}),
		);
	});

	it('forwards section as parse section for html content', async () => {
		const request = vi.fn().mockResolvedValue({
			parse: { text: '<p>Section HTML</p>' },
		});
		const mock = createMockMwn({ request });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.html,
				metadata: false,
				section: 1,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('HTML: <p>Section HTML</p>');
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'parse',
				page: 'Test Page',
				section: 1,
			}),
		);
	});

	it('rejects section with content="none"', async () => {
		const ctx = fakeContext();

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.none,
				metadata: true,
				section: 2,
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('section is not compatible with content="none"');
	});

	it('reports the full-page size in metadata even when section is set', async () => {
		const read = vi.fn().mockResolvedValue({
			pageid: 1,
			title: 'Test Page',
			revisions: [
				{
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					size: 98765,
					content: 'Section body',
				},
			],
		});
		const request = vi.fn().mockResolvedValue({
			parse: { sections: [{ line: 'History' }] },
		});
		const mock = createMockMwn({ read, request });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.source,
				metadata: true,
				section: 1,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Size: 98765');
		expect(read).toHaveBeenCalledWith(
			'Test Page',
			expect.objectContaining({
				rvsection: 1,
			}),
		);
	});

	it('omits size from metadata when the revision has no size field', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'No Size',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
					},
				],
			}),
			request: vi.fn().mockResolvedValue({ parse: { sections: [] } }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'No Size',
				content: ContentFormat.none,
				metadata: true,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Size:');
	});

	it('metadata=true includes size and sections array (lead slot is empty string)', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Test Page',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
						size: 12345,
					},
				],
			}),
			request: vi.fn().mockResolvedValue({
				parse: {
					sections: [
						{ line: 'History', number: '1', index: '1' },
						{ line: 'Background', number: '2', index: '2' },
					],
				},
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.none,
				metadata: true,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Size: 12345');
		expect(text).toContain('Sections:\n- 0 (Lead)\n- 1 (History)\n- 2 (Background)');
	});

	it('attaches content-truncated truncation when source exceeds the byte cap', async () => {
		const big = 'x'.repeat(50001);
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Big',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
						content: big,
					},
				],
			}),
			request: vi.fn().mockResolvedValue({
				parse: { sections: [{ line: 'History', index: '1', level: '2' }] },
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Big',
				content: ContentFormat.source,
				metadata: false,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		// Source body is ~50000 chars, rendered as long-string block after Source: label.
		expect(text).toMatch(/Source:\n\nx{50000}/);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).toContain('  Returned bytes: 50000');
		expect(text).toContain('  Total bytes: 50001');
		expect(text).toContain('  Item noun: wikitext');
		expect(text).toContain('  Tool name: get-page');
		expect(text).toContain('  Sections:\n  - 0 (Lead)\n  - 1 (History)');
	});

	it('omits truncation when source is exactly at the byte cap', async () => {
		const exact = 'y'.repeat(50000);
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Exact',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
						content: exact,
					},
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getPage.handle(
			{
				title: 'Exact',
				content: ContentFormat.source,
				metadata: false,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toMatch(/Source:\n\ny{50000}/);
		expect(text).not.toContain('Truncation:');
	});

	it('attaches content-truncated truncation when HTML exceeds the byte cap', async () => {
		const bigHtml = '<p>' + 'x'.repeat(60000) + '</p>';
		const request = vi
			.fn()
			.mockResolvedValueOnce({ parse: { text: bigHtml } })
			.mockResolvedValueOnce({
				parse: { sections: [{ line: 'Heading', index: '1', level: '2' }] },
			});
		const mock = createMockMwn({ request });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Huge',
				content: ContentFormat.html,
				metadata: false,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		// Truncated HTML is rendered as long-string block.
		expect(text).toMatch(/HTML:\n\n<p>x+/);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Reason: content-truncated');
		expect(text).toContain('  Returned bytes: 50000');
		expect(text).toContain('  Item noun: HTML');
		expect(text).toContain('  Tool name: get-page');
		expect(text).toContain('  Sections:\n  - 0 (Lead)\n  - 1 (Heading)');
	});

	// A caller that already passed section=N cannot narrow by passing it again,
	// so the marker names that section's own subsections instead of the outline
	// of a page it did not ask for.
	it("lists the requested section's subsections when a section read is truncated", async () => {
		const list = vi.fn().mockResolvedValue([
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: '2', level: 3, line: 'Origins', editable: true },
			{ index: '3', level: 3, line: 'Modern era', editable: true },
			{ index: '4', level: 2, line: 'Geography', editable: true },
		]);
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Big',
				revisions: [{ revid: 42, contentmodel: 'wikitext', content: 'x'.repeat(50001) }],
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: { list, listInSource: vi.fn() },
		});

		const result = await getPage.handle(
			{ title: 'Big', content: ContentFormat.source, metadata: false, section: 1 },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('  Sections:\n  - 2 (Origins)\n  - 3 (Modern era)');
		expect(text).not.toContain('Geography');
		expect(text).toContain('subsection numbers');
	});

	it('reports that no narrower read exists when the truncated section has no subsections', async () => {
		const list = vi.fn().mockResolvedValue([
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: '2', level: 2, line: 'Geography', editable: true },
		]);
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Big',
				revisions: [{ revid: 42, contentmodel: 'wikitext', content: 'x'.repeat(50001) }],
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: { list, listInSource: vi.fn() },
		});

		const result = await getPage.handle(
			{ title: 'Big', content: ContentFormat.source, metadata: false, section: 1 },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('No narrower read returns more of this section');
		expect(text).toContain("operation='find-replace'");
		// Naming the sections of a page the caller did not ask for is what sent it
		// back to the call it had just made.
		expect(text).not.toContain('Sections:');
		expect(text).not.toContain('Geography');
	});

	// The lead has no heading of its own, so childrenOf finds no entry for it.
	it('reports that no narrower read exists when a truncated lead read has no subsections', async () => {
		const list = vi
			.fn()
			.mockResolvedValue([{ index: '1', level: 2, line: 'History', editable: true }]);
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Big',
				revisions: [{ revid: 42, contentmodel: 'wikitext', content: 'x'.repeat(50001) }],
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: { list, listInSource: vi.fn() },
		});

		const result = await getPage.handle(
			{ title: 'Big', content: ContentFormat.source, metadata: false, section: 0 },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('No narrower read returns more of this section');
	});

	it('builds the page URL from the public siteinfo server, not the configured server', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockImplementation((params: { meta?: string; action?: string }) => {
				if (params.meta === 'siteinfo') {
					return Promise.resolve({
						query: { general: { server: 'https://public.example', articlepath: '/wiki/$1' } },
					});
				}
				// action=parse response for html content
				return Promise.resolve({
					parse: { text: '<p>Hello</p>', title: 'Test Page', pageid: 1 },
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

		const result = await getPage.handle(
			{ title: 'Test Page', content: ContentFormat.html, metadata: false },
			ctx,
		);
		const text = assertStructuredSuccess(result);
		expect(text).toContain('https://public.example/wiki/Test_Page');
	});

	it('html+metadata calls read once and returns both metadata and html', async () => {
		const mock = createMockMwn({
			read: vi.fn().mockResolvedValue({
				pageid: 1,
				title: 'Test Page',
				revisions: [
					{
						revid: 42,
						timestamp: '2026-01-01T00:00:00Z',
						contentmodel: 'wikitext',
					},
				],
			}),
			request: vi
				.fn()
				.mockResolvedValueOnce({ parse: { sections: [] } })
				.mockResolvedValueOnce({ parse: { text: '<p>Hello</p>' } }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			sections: new SectionServiceImpl(),
		});

		const result = await getPage.handle(
			{
				title: 'Test Page',
				content: ContentFormat.html,
				metadata: true,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(mock.read).toHaveBeenCalledTimes(1);
		expect(text).toContain('Page ID: 1');
		expect(text).toContain('HTML: <p>Hello</p>');
	});
});
