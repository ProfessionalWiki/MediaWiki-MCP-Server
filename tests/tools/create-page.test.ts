import { describe, it, expect } from 'vitest';
import { createPage } from '../../src/tools/create-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { contextWritingTo, writingWiki, type WritingWiki } from '../helpers/writingWiki.ts';

const CREATED = {
	edit: {
		result: 'Success',
		pageid: 10,
		title: 'New Page',
		contentmodel: 'wikitext',
		oldrevid: 0,
		newrevid: 1,
		newtimestamp: '2026-01-01T00:00:00Z',
	},
};

// The wiki answers the write with `answers.editResponse`, or a successful
// creation, and reports `answers.rights` for the account.
function fakeWiki(answers: { editResponse?: object; rights?: string[] } = {}): WritingWiki {
	return writingWiki(answers.editResponse ?? CREATED, { rights: answers.rights });
}

describe('create-page', () => {
	it('sends the source as a create-only edit', async () => {
		const wiki = fakeWiki();

		await createPage.handle(
			{ source: 'Hello', title: 'New Page', comment: 'Seeding the page' },
			contextWritingTo(wiki),
		);

		const sent = wiki.sentWrite();
		expect(sent.get('action')).toBe('edit');
		expect(sent.get('title')).toBe('New Page');
		expect(sent.get('text')).toBe('Hello');
		expect(sent.get('createonly')).toBe('1');
		expect(sent.get('summary')).toContain('Seeding the page');
	});

	it("reports the new page's ID, revision and URL", async () => {
		const wiki = fakeWiki();

		const result = await createPage.handle(
			{ source: 'Hello', title: 'New Page' },
			contextWritingTo(wiki),
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Page ID: 10');
		expect(text).toContain('Title: New Page');
		expect(text).toContain('Latest revision ID: 1');
		expect(text).toContain('Latest revision timestamp: 2026-01-01T00:00:00Z');
		expect(text).toContain('Content model: wikitext');
		expect(text).toContain('/wiki/New_Page');
	});

	it("tags the edit with the wiki's configured change tags", async () => {
		const wiki = fakeWiki();

		await createPage.handle(
			{ source: 'Hello', title: 'New Page' },
			contextWritingTo(wiki, 'mcp-server'),
		);

		expect(wiki.sentWrite().get('tags')).toBe('mcp-server');
	});

	it('sends the given content model', async () => {
		const wiki = fakeWiki();

		await createPage.handle(
			{ source: 'mw.log()', title: 'Module:Foo', contentModel: 'Scribunto' },
			contextWritingTo(wiki),
		);

		expect(wiki.sentWrite().get('contentmodel')).toBe('Scribunto');
	});

	it('leaves the content model to MediaWiki when none is given', async () => {
		const wiki = fakeWiki();

		await createPage.handle({ source: 'mw.log()', title: 'Module:Foo' }, contextWritingTo(wiki));

		expect(wiki.sentWrite().has('contentmodel')).toBe(false);
	});

	it('fails as conflict when the page already exists', async () => {
		const wiki = fakeWiki({
			editResponse: {
				error: {
					code: 'articleexists',
					info: 'The page you tried to create has been created already.',
				},
			},
		});

		const result = await dispatch(
			createPage,
			contextWritingTo(wiki),
		)({ source: 'Hello', title: 'New Page' });

		const envelope = assertStructuredError(result, 'conflict', 'articleexists');
		expect(envelope.message).toMatch(/Failed to create page/);
	});

	it('fails when the wiki refuses the edit without an error code', async () => {
		const wiki = fakeWiki({
			editResponse: { edit: { result: 'Failure', captcha: { type: 'image' } } },
		});

		const result = await dispatch(
			createPage,
			contextWritingTo(wiki),
		)({ source: 'Hello', title: 'New Page' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('captcha');
	});

	describe('bot flag', () => {
		it('does not mark the edit as a bot edit unless asked', async () => {
			const wiki = fakeWiki({ rights: ['bot'] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page' },
				contextWritingTo(wiki),
			);

			expect(wiki.sentWrite().has('bot')).toBe(false);
			expect(assertStructuredSuccess(result)).not.toContain('Bot marked');
		});

		it('marks the edit as a bot edit when asked and reports that it was marked', async () => {
			const wiki = fakeWiki({ rights: ['bot'] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page', bot: true },
				contextWritingTo(wiki),
			);

			expect(wiki.sentWrite().get('bot')).toBe('1');
			expect(assertStructuredSuccess(result)).toContain('Bot marked: true');
		});

		it('reports botMarked false when the account lacks the bot right', async () => {
			const wiki = fakeWiki({ rights: [] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page', bot: true },
				contextWritingTo(wiki),
			);

			expect(assertStructuredSuccess(result)).toContain('Bot marked: false');
		});
	});
});
