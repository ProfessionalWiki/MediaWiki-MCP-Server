import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { undeletePage } from '../../src/tools/undelete-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { formatPayload } from '../../src/results/format.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('undelete-page', () => {
	it('returns a structured payload on success', async () => {
		const mock = createMockMwn({
			undelete: vi.fn().mockResolvedValue({
				title: 'Restored Page',
				reason: 'oops',
				revisions: 12,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await undeletePage.handle({ title: 'Restored Page', comment: 'oops' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({
				title: 'Restored Page',
				restored: true,
				revisionCount: 12,
			}),
		);
		expect(mock.undelete).toHaveBeenCalledWith(
			'Restored Page',
			expect.stringContaining('oops'),
			expect.any(Object),
		);
	});

	it('works without a revision count', async () => {
		const mock = createMockMwn({
			undelete: vi.fn().mockResolvedValue({ title: 'Restored Page' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await undeletePage.handle({ title: 'Restored Page' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Revision count:');
	});

	it('dispatches permissiondenied as permission_denied via dispatcher', async () => {
		const mock = createMockMwn({
			undelete: vi.fn().mockRejectedValue(createMockMwnError('permissiondenied')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(undeletePage, ctx)({ title: 'Protected' });

		assertStructuredError(result, 'permission_denied', 'permissiondenied');
	});

	it('dispatches generic upstream failures with the standard verb prefix', async () => {
		const mock = createMockMwn({
			undelete: vi.fn().mockRejectedValue(new Error('Network down')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(undeletePage, ctx)({ title: 'Some Page' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/Failed to undelete page: Network down/);
	});

	it('forwards configured tags via ctx.edit.applyTags', async () => {
		const mock = createMockMwn({
			undelete: vi.fn().mockResolvedValue({ title: 'X' }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: (o: object) => ({ ...o, tags: 'mcp-edit' }),
			},
		});

		await undeletePage.handle({ title: 'X' }, ctx);

		expect(mock.undelete).toHaveBeenCalledWith('X', expect.any(String), { tags: 'mcp-edit' });
	});
});
