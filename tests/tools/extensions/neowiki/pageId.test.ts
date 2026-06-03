import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { resolvePageId, hasOnePageRef } from '../../../../src/tools/extensions/neowiki/pageId.js';

describe('hasOnePageRef', () => {
	it('is true for exactly one of title/pageId', () => {
		expect(hasOnePageRef({ title: 'A' })).toBe(true);
		expect(hasOnePageRef({ pageId: 1 })).toBe(true);
		expect(hasOnePageRef({})).toBe(false);
		expect(hasOnePageRef({ title: 'A', pageId: 1 })).toBe(false);
	});
});

describe('resolvePageId', () => {
	it('returns a passed pageId without calling the API', async () => {
		const mock = createMockMwn();
		expect(await resolvePageId(mock as never, { pageId: 42 })).toBe(42);
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('resolves a title to its page id', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ pageid: 7, title: 'Berlin' }] } }),
		});
		expect(await resolvePageId(mock as never, { title: 'Berlin' })).toBe(7);
	});

	it('returns null for a missing page', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
		});
		expect(await resolvePageId(mock as never, { title: 'Nope' })).toBeNull();
	});
});
