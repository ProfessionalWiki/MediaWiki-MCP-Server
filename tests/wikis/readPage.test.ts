import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { readPage } from '../../src/wikis/readPage.ts';

function wikiAnsweringRead(response: object): ReturnType<typeof createMockMwn> {
	return createMockMwn({ request: vi.fn().mockResolvedValue(response) });
}

describe('readPage', () => {
	it("sets the main slot's content and model on each revision", async () => {
		const mock = wikiAnsweringRead({
			query: {
				pages: [
					{
						pageid: 1,
						title: 'Test Page',
						revisions: [
							{ revid: 42, slots: { main: { contentmodel: 'wikitext', content: 'Hello' } } },
						],
					},
				],
			},
		});

		const page = await readPage(mock as never, 'Test Page', { redirects: true });

		expect(page.revisions?.[0]).toMatchObject({ contentmodel: 'wikitext', content: 'Hello' });
	});

	it('fails when the wiki returns no page', async () => {
		const mock = wikiAnsweringRead({ batchcomplete: true });

		await expect(readPage(mock as never, '', { redirects: true })).rejects.toThrow(
			'The wiki returned no page for ""',
		);
	});
});
