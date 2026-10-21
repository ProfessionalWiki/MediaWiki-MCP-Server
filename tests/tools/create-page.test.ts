import { describe, it, expect, vi } from 'vitest';
import { Mwn } from 'mwn';
import { fakeContext } from '../helpers/fakeContext.ts';
import { createPage } from '../../src/tools/create-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { EditServiceImpl } from '../../src/services/editService.ts';
import type { ToolContext } from '../../src/runtime/context.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

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

interface FakeWiki {
	mwn: Mwn;
	sentEdit: () => URLSearchParams;
}

// A real Mwn with only its HTTP layer stubbed, so mwn's own parameter handling
// runs and the assertions see the edit as the wiki receives it, including any
// default mwn adds on the way.
function fakeWiki(answers: { editResponse?: object; rights?: string[] } = {}): FakeWiki {
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	let editBody: string | undefined;
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: {
		params?: Record<string, string>;
		data?: string;
	}) => {
		if (request.params?.meta === 'tokens') {
			return { data: { query: { tokens: { csrftoken: 'csrf-token' } } } };
		}
		if (request.params?.meta === 'userinfo') {
			return { data: { query: { userinfo: { rights: answers.rights ?? [] } } } };
		}
		editBody = request.data;
		return { data: answers.editResponse ?? CREATED };
	}) as never);
	return {
		mwn,
		sentEdit: () => {
			if (editBody === undefined) {
				throw new Error('No edit reached the wiki');
			}
			return new URLSearchParams(editBody);
		},
	};
}

function contextFor(wiki: FakeWiki, tags: string | null = null): ToolContext {
	const base = fakeContext();
	const activeWiki = {
		...base.activeWiki,
		get: () => {
			const { key, config } = base.activeWiki.get();
			return { key, config: { ...config, tags } };
		},
	};
	return fakeContext({
		mwn: async () => wiki.mwn,
		activeWiki,
		edit: new EditServiceImpl(activeWiki),
	});
}

describe('create-page', () => {
	it('sends the source as a create-only edit', async () => {
		const wiki = fakeWiki();

		await createPage.handle(
			{ source: 'Hello', title: 'New Page', comment: 'Seeding the page' },
			contextFor(wiki),
		);

		const sent = wiki.sentEdit();
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
			contextFor(wiki),
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

		await createPage.handle({ source: 'Hello', title: 'New Page' }, contextFor(wiki, 'mcp-server'));

		expect(wiki.sentEdit().get('tags')).toBe('mcp-server');
	});

	it('sends the given content model', async () => {
		const wiki = fakeWiki();

		await createPage.handle(
			{ source: 'mw.log()', title: 'Module:Foo', contentModel: 'Scribunto' },
			contextFor(wiki),
		);

		expect(wiki.sentEdit().get('contentmodel')).toBe('Scribunto');
	});

	it('leaves the content model to MediaWiki when none is given', async () => {
		const wiki = fakeWiki();

		await createPage.handle({ source: 'mw.log()', title: 'Module:Foo' }, contextFor(wiki));

		expect(wiki.sentEdit().has('contentmodel')).toBe(false);
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
			contextFor(wiki),
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
			contextFor(wiki),
		)({ source: 'Hello', title: 'New Page' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('captcha');
	});

	describe('bot flag', () => {
		it('does not mark the edit as a bot edit unless asked', async () => {
			const wiki = fakeWiki({ rights: ['bot'] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page' },
				contextFor(wiki),
			);

			expect(wiki.sentEdit().has('bot')).toBe(false);
			expect(assertStructuredSuccess(result)).not.toContain('Bot marked');
		});

		it('marks the edit as a bot edit when asked and reports that it was marked', async () => {
			const wiki = fakeWiki({ rights: ['bot'] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page', bot: true },
				contextFor(wiki),
			);

			expect(wiki.sentEdit().get('bot')).toBe('1');
			expect(assertStructuredSuccess(result)).toContain('Bot marked: true');
		});

		it('reports botMarked false when the account lacks the bot right', async () => {
			const wiki = fakeWiki({ rights: [] });

			const result = await createPage.handle(
				{ source: 'Hello', title: 'New Page', bot: true },
				contextFor(wiki),
			);

			expect(assertStructuredSuccess(result)).toContain('Bot marked: false');
		});
	});
});
