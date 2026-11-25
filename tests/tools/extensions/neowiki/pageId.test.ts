import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { rejectionOf } from '../../../helpers/rejectionOf.ts';
import { pageIdOf } from '../../../../src/tools/extensions/neowiki/pageId.ts';

function contextFindingPages(pages: unknown[]): ReturnType<typeof contextOn> {
	return contextOn(createMockMwn({ request: vi.fn().mockResolvedValue({ query: { pages } }) }));
}

describe('pageIdOf', () => {
	it.each([
		['neither', {}],
		['both', { title: 'Berlin', pageId: 7 }],
	])('refuses a reference that names %s of a title and a page ID', async (_, ref) => {
		const err = await rejectionOf(pageIdOf(contextFindingPages([]), ref));

		expect(err).toMatchObject({ category: 'invalid_input' });
	});

	it('takes a page ID as given, without asking the wiki', async () => {
		const mock = createMockMwn();

		expect(await pageIdOf(contextOn(mock), { pageId: 42 })).toBe(42);
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('resolves a title to the ID of its page', async () => {
		const ctx = contextFindingPages([{ pageid: 7, title: 'Berlin' }]);

		expect(await pageIdOf(ctx, { title: 'Berlin' })).toBe(7);
	});

	it('reports a title without a page as not found', async () => {
		const ctx = contextFindingPages([{ missing: true, title: 'Nope' }]);

		const err = await rejectionOf(pageIdOf(ctx, { title: 'Nope' }));

		expect(err).toMatchObject({ category: 'not_found', message: 'Page "Nope" not found' });
	});
});
