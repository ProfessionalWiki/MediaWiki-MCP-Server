import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { fakeContext, withoutEditAttribution } from '../helpers/fakeContext.ts';
import { deletePage } from '../../src/tools/delete-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

// The default fake EditService; each test spreads it and replaces only the
// slice it exercises, so an unexpected call to another member still throws.
const baseEdit = fakeContext().edit;

describe('delete-page', () => {
	it('returns a structured payload on success', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockResolvedValue({
				title: 'Old Page',
				reason: 'spam',
				logid: 42,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await deletePage.handle({ title: 'Old Page', comment: 'spam' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({
				title: 'Old Page',
				deleted: true,
				logId: 42,
			}),
		);
		expect(mock.delete).toHaveBeenCalledWith(
			'Old Page',
			expect.stringContaining('spam'),
			expect.any(Object),
		);
	});

	it('works without a logid in the response', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockResolvedValue({ title: 'Old Page' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await deletePage.handle({ title: 'Old Page' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Log ID:');
	});

	it('dispatches missingtitle as not_found via dispatcher', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockRejectedValue(createMockMwnError('missingtitle')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(deletePage, ctx)({ title: 'Nonexistent' });

		assertStructuredError(result, 'not_found', 'missingtitle');
	});

	it('dispatches permissiondenied as permission_denied via dispatcher', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockRejectedValue(createMockMwnError('permissiondenied')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(deletePage, ctx)({ title: 'Protected' });

		assertStructuredError(result, 'permission_denied', 'permissiondenied');
	});

	// An empty reason is not an absent one: ApiDelete autogenerates its
	// "content was: …" reason only when the parameter arrives as null, so
	// sending it empty leaves the deletion log entry blank.
	it('sends no reason at all when a wiki opts out and the caller gave no comment', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockResolvedValue({ title: 'X' }),
		});
		const ctx = withoutEditAttribution(fakeContext({ mwn: async () => mock as never }));

		await deletePage.handle({ title: 'X' }, ctx);

		expect(mock.delete).toHaveBeenCalledWith('X', undefined, expect.any(Object));
	});

	it('sends the caller comment as the reason when a wiki opts out', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockResolvedValue({ title: 'X' }),
		});
		const ctx = withoutEditAttribution(fakeContext({ mwn: async () => mock as never }));

		await deletePage.handle({ title: 'X', comment: 'spam' }, ctx);

		expect(mock.delete).toHaveBeenCalledWith('X', 'spam', expect.any(Object));
	});

	it('injects tags from selection when configured', async () => {
		const mock = createMockMwn({
			delete: vi.fn().mockResolvedValue({ title: 'X' }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				...baseEdit,
				applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o, tags: 'mcp-edit' }),
			},
		});

		await deletePage.handle({ title: 'X' }, ctx);

		expect(mock.delete).toHaveBeenCalledWith('X', expect.stringContaining('Automated edit'), {
			tags: 'mcp-edit',
		});
	});
});
