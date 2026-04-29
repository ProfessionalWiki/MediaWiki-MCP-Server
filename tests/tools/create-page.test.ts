import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { createPage } from '../../src/tools/create-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('create-page', () => {
	it('calls mwn.create() with correct params', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockResolvedValue({
				result: 'Success',
				pageid: 10,
				title: 'New Page',
				contentmodel: 'wikitext',
				oldrevid: 0,
				newrevid: 1,
				newtimestamp: '2026-01-01T00:00:00Z',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await createPage.handle(
			{
				source: 'Hello',
				title: 'New Page',
				comment: 'test',
				contentModel: 'wikitext',
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Page ID: 10');
		expect(text).toContain('Title: New Page');
		expect(text).toContain('Latest revision ID: 1');
		expect(text).toContain('Latest revision timestamp: 2026-01-01T00:00:00Z');
		expect(text).toContain('Content model: wikitext');
		expect(text).toContain('URL: ');
		expect(text).toContain('/wiki/New_Page');
		expect(mock.create).toHaveBeenCalledWith(
			'New Page',
			'Hello',
			expect.stringContaining('test'),
			expect.objectContaining({ contentmodel: 'wikitext' }),
		);
	});

	it('omits contentmodel when not provided, letting MediaWiki auto-detect by namespace', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockResolvedValue({
				result: 'Success',
				pageid: 11,
				title: 'Module:Foo',
				contentmodel: 'Scribunto',
				oldrevid: 0,
				newrevid: 2,
				newtimestamp: '2026-01-01T00:00:00Z',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await createPage.handle(
			{
				source: '-- lua',
				title: 'Module:Foo',
			},
			ctx,
		);

		const opts = mock.create.mock.calls[0][3];
		expect(opts).not.toHaveProperty('contentmodel');
	});

	it('dispatches articleexists as conflict via dispatcher', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockRejectedValue(createMockMwnError('articleexists')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			createPage,
			ctx,
		)({
			source: 'Hello',
			title: 'Existing Page',
			contentModel: 'wikitext',
		});

		const envelope = assertStructuredError(result, 'conflict', 'articleexists');
		expect(envelope.message).toMatch(/Failed to create page/);
	});

	it('dispatches generic upstream errors with the standard verb prefix', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockRejectedValue(new Error('Page exists')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			createPage,
			ctx,
		)({
			source: 'Hello',
			title: 'Existing Page',
			contentModel: 'wikitext',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('Page exists');
		expect(envelope.message).toMatch(/Failed to create page/);
	});

	it('forwards configured tags via ctx.edit.applyTags', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockResolvedValue({
				result: 'Success',
				pageid: 12,
				title: 'Tagged Page',
				contentmodel: 'wikitext',
				oldrevid: 0,
				newrevid: 3,
				newtimestamp: '2026-01-01T00:00:00Z',
			}),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: (o: object) => ({ ...o, tags: 'mcp-server' }),
			},
		});

		await createPage.handle(
			{
				source: 'Hello',
				title: 'Tagged Page',
			},
			ctx,
		);

		const opts = mock.create.mock.calls[0][3];
		expect(opts).toHaveProperty('tags', 'mcp-server');
	});

	it('omits tags from options when applyTags returns no tags', async () => {
		const mock = createMockMwn({
			create: vi.fn().mockResolvedValue({
				result: 'Success',
				pageid: 13,
				title: 'Untagged Page',
				contentmodel: 'wikitext',
				oldrevid: 0,
				newrevid: 4,
				newtimestamp: '2026-01-01T00:00:00Z',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await createPage.handle(
			{
				source: 'Hello',
				title: 'Untagged Page',
			},
			ctx,
		);

		const opts = mock.create.mock.calls[0][3];
		expect(opts).not.toHaveProperty('tags');
	});
});
