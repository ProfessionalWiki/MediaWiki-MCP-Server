import { describe, it, expect, vi, afterEach } from 'vitest';
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
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		function revisionWith(content: string, lastrevid = 42) {
			return createMockMwn({
				request: vi.fn().mockResolvedValue({
					query: {
						pages: [{ pageid: 1, title: 'Big', lastrevid, revisions: [{ revid: 42, content }] }],
					},
				}),
			});
		}

		it('truncates source at the byte cap and says how much it withheld', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '500');
			const ctx = fakeContext({ mwn: async () => revisionWith('x'.repeat(501)) as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toMatch(/Source:\n\nx{500}\n/);
			expect(text).toContain('  Reason: content-truncated');
			expect(text).toContain('  Returned bytes: 500');
			expect(text).toContain('  Total bytes: 501');
			expect(text).toContain('  Tool name: get-revision');
		});

		it('leaves source alone at exactly the cap', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '500');
			const ctx = fakeContext({ mwn: async () => revisionWith('x'.repeat(500)) as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).not.toContain('Truncation:');
		});

		it('truncates rendered HTML too', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '500');
			const mock = createMockMwn({
				request: vi.fn().mockResolvedValue({
					parse: { title: 'Big', pageid: 1, text: '<p>' + 'x'.repeat(501) + '</p>' },
				}),
			});
			const ctx = fakeContext({ mwn: async () => mock as never });

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.html, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('  Item noun: HTML');
			expect(text).toContain('  Returned bytes: 500');
			// Rendering HTML alone makes no revisions query, so which revision this
			// is cannot be known and the remedy names both routes.
			expect(text).toContain('If this is the page');
		});

		// section= addresses the page as it stands, which is the same bytes only
		// when the revision asked for is the current one.
		it('sends a past revision to compare-pages', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '500');
			const ctx = fakeContext({
				mwn: async () => revisionWith('x'.repeat(501), 99) as never,
			});

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('No narrower read of a past revision');
			expect(text).toContain('compare-pages');
			expect(text).not.toContain('Sections:');
		});

		// A revision ID taken from get-page metadata or from an edit that just
		// landed is the current one, and section= reads exactly those bytes.
		it('sends the current revision to get-page with a section', async () => {
			vi.stubEnv('MCP_CONTENT_MAX_BYTES', '500');
			const ctx = fakeContext({
				mwn: async () => revisionWith('x'.repeat(501), 42) as never,
			});

			const result = await getRevision.handle(
				{ revisionId: 42, content: ContentFormat.source, metadata: false },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('current revision');
			expect(text).toContain('section=N');
			expect(text).not.toContain('compare-pages');
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
