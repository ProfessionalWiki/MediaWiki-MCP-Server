import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { getRevision } from '../../src/tools/get-revision.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { ContentFormat } from '../../src/results/contentFormat.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

describe('get-revision', () => {
	// A past revision was the one read this server never capped, so a caller could
	// be handed several megabytes where every sibling read stops at the budget.
	describe('content cap', () => {
		function revisionWith(content: string) {
			return createMockMwn({
				request: vi.fn().mockResolvedValue({
					query: {
						pages: [{ pageid: 1, title: 'Big', revisions: [{ revid: 42, content }] }],
					},
				}),
			});
		}

		it('truncates source at the byte cap and says how much it withheld', async () => {
			const ctx = fakeContext({ mwn: async () => revisionWith('x'.repeat(100001)) as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toMatch(/Source:\n\nx{100000}\n/);
			expect(text).toContain('  Reason: content-truncated');
			expect(text).toContain('  Returned bytes: 100000');
			expect(text).toContain('  Total bytes: 100001');
			expect(text).toContain('  Tool name: get-revision');
		});

		it('leaves source alone at exactly the cap', async () => {
			const ctx = fakeContext({ mwn: async () => revisionWith('x'.repeat(100000)) as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).not.toContain('Truncation:');
		});

		it('truncates rendered HTML too', async () => {
			const mock = createMockMwn({
				request: vi.fn().mockResolvedValue({
					parse: { title: 'Big', pageid: 1, text: '<p>' + 'x'.repeat(100001) + '</p>' },
				}),
			});
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.html, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('  Item noun: HTML');
			expect(text).toContain('  Returned bytes: 100000');
		});

		// A past revision has no narrower read: section= addresses the current page.
		it('says no narrower read exists, and names what does help', async () => {
			const ctx = fakeContext({ mwn: async () => revisionWith('x'.repeat(100001)) as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('No narrower read of a past revision');
			expect(text).toContain('compare-pages');
			expect(text).not.toContain('Sections:');
		});
	});

	it('returns source content from a specific revision', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							pageid: 1,
							title: 'Test Page',
							revisions: [
								{
									revid: 42,
									timestamp: '2026-01-01T00:00:00Z',
									user: 'Admin',
									userid: 1,
									comment: 'edit',
									size: 500,
									minor: false,
									content: 'Hello world',
								},
							],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.source, metadata: false },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Source: Hello world');
		expect(text).toContain('Revision ID: 42');
		expect(text).toContain('Title: Test Page');
		expect(text).not.toContain('User:');
	});

	it('returns HTML content using action=parse', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				parse: { text: '<p>Hello</p>' },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.html, metadata: false },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('HTML: <p>Hello</p>');
		expect(text).toContain('Revision ID: 42');
	});

	it('returns metadata with minor edit flag', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							pageid: 1,
							title: 'Test Page',
							revisions: [
								{
									revid: 42,
									timestamp: '2026-01-01T00:00:00Z',
									user: 'Admin',
									userid: 1,
									comment: 'minor fix',
									size: 500,
									minor: true,
								},
							],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.none, metadata: true },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Minor: true');
		expect(text).toMatch(/URL: .*Test_Page/);
		expect(text).not.toContain('Source:');
		expect(text).not.toContain('HTML:');
	});

	it('returns error when revision is not found', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							pageid: 0,
							title: '',
							missing: true,
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getRevision.handle(
			{ revisionId: 99999, content: ContentFormat.source, metadata: false },
			ctx,
		);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('returns error on failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			getRevision,
			ctx,
		)({
			revisionId: 42,
			content: ContentFormat.source,
			metadata: false,
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});
});
