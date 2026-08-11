import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseSearchEntities } from '../../../../src/tools/extensions/wikibase/wikibase-search-entities.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';
import {
	assertStructuredError,
	assertStructuredSuccess,
} from '../../../helpers/structuredResult.ts';

const DOUGLAS_ADAMS = {
	search: [
		{
			id: 'Q42',
			label: 'Douglas Adams',
			description: 'British science fiction writer and humorist',
			match: { type: 'label', language: 'en', text: 'Douglas Adams' },
		},
		{
			id: 'Q28421831',
			label: 'Douglas Adams',
			description: 'American environmental engineer',
			match: { type: 'label', language: 'en', text: 'Douglas Adams' },
		},
	],
};

function contextWith(response: unknown, lang?: string) {
	const mock = createMockMwn({ request: vi.fn().mockResolvedValue(response) });
	const ctx = fakeContext({ mwn: async () => mock as never });
	if (lang !== undefined) {
		ctx.siteInfoCache.set('test-wiki', {
			server: 'https://test.wiki',
			articlepath: '/wiki',
			lang,
		});
	}
	return { mock, ctx };
}

describe('wikibase-search-entities', () => {
	it('searches items and renders one id — label — description line per match', async () => {
		const { mock, ctx } = contextWith(DOUGLAS_ADAMS);

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams' }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Q42 — Douglas Adams — British science fiction writer and humorist');
		expect(text).toContain('Q28421831 — Douglas Adams — American environmental engineer');
		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'wbsearchentities',
			search: 'Douglas Adams',
			type: 'item',
		});
	});

	it('searches properties and reports each property datatype', async () => {
		const { mock, ctx } = contextWith({
			search: [
				{
					id: 'P106',
					label: 'occupation',
					description: 'occupation of a person',
					datatype: 'wikibase-item',
					match: { type: 'label', language: 'en', text: 'occupation' },
				},
			],
		});

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'occupation', entityType: 'property' }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('P106 — occupation — occupation of a person [wikibase-item]');
		expect(mock.request.mock.calls[0][0]).toMatchObject({ type: 'property' });
	});

	it('names the alias a match came from', async () => {
		const { ctx } = contextWith({
			search: [
				{
					id: 'Q42',
					label: 'Douglas Adams',
					description: 'writer',
					aliases: ['Douglas Noel Adams'],
					match: { type: 'alias', language: 'en', text: 'Douglas Noel Adams' },
				},
			],
		});

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Noel Adams' }),
			ctx,
		);

		expect(assertStructuredSuccess(result)).toContain('(matched alias: Douglas Noel Adams)');
	});

	it('clamps a description that would dominate its line', async () => {
		const { ctx } = contextWith({
			search: [{ id: 'Q42', label: 'Douglas Adams', description: 'x'.repeat(600) }],
		});

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams' }),
			ctx,
		);

		expect(assertStructuredSuccess(result)).toContain(`Q42 — Douglas Adams — ${'x'.repeat(200)}…`);
	});

	// Cutting UTF-16 units instead of characters leaves half an astral character
	// behind, which is not text any more.
	it('clamps a description without splitting a character that straddles the limit', async () => {
		const { ctx } = contextWith({
			search: [
				{
					id: 'Q42',
					label: 'Douglas Adams',
					description: `${'x'.repeat(199)}😀${'y'.repeat(100)}`,
				},
			],
		});

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams' }),
			ctx,
		);

		expect(assertStructuredSuccess(result)).toContain(
			`Q42 — Douglas Adams — ${'x'.repeat(199)}😀…`,
		);
	});

	it('asks the wiki for both the search language and the returned label language', async () => {
		const { mock, ctx } = contextWith(DOUGLAS_ADAMS, 'de');

		await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, {
				query: 'Douglas Adams',
				entityType: 'property',
				language: 'fr',
				limit: 5,
			}),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			search: 'Douglas Adams',
			language: 'fr',
			uselang: 'fr',
			type: 'property',
			limit: 5,
			formatversion: '2',
		});
	});

	it('defaults the search language to the wiki content language', async () => {
		const { mock, ctx } = contextWith(DOUGLAS_ADAMS, 'de');

		await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams' }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({ language: 'de' });
	});

	it('uses the requested language over the wiki content language', async () => {
		const { mock, ctx } = contextWith(DOUGLAS_ADAMS, 'de');

		await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams', language: 'fr' }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({ language: 'fr' });
	});

	it('applies the documented default limit', async () => {
		const { mock, ctx } = contextWith(DOUGLAS_ADAMS);

		await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams' }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({ limit: 10 });
	});

	it('rejects a limit above the hard cap', () => {
		expect(() => toolArgs(wikibaseSearchEntities, { query: 'x', limit: 51 })).toThrow();
	});

	it('reports no matches without inventing a result line', async () => {
		const { ctx } = contextWith({ search: [] });

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'zzzz' }),
			ctx,
		);

		expect(result.structuredContent).toMatchObject({ results: [] });
	});

	it('reports more matches when the wiki says where it would resume', async () => {
		const { ctx } = contextWith({ ...DOUGLAS_ADAMS, 'search-continue': 2 });

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams', limit: 2 }),
			ctx,
		);

		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'capped-no-continuation', limit: 2, itemNoun: 'matches' },
		});
	});

	it('reports no truncation for a full page the wiki does not continue', async () => {
		const { ctx } = contextWith(DOUGLAS_ADAMS);

		const result = await wikibaseSearchEntities.handle(
			toolArgs(wikibaseSearchEntities, { query: 'Douglas Adams', limit: 2 }),
			ctx,
		);

		expect((result.structuredContent as Record<string, unknown>).truncation).toBeUndefined();
	});

	it('rejects a language list where one language code belongs', () => {
		expect(() => toolArgs(wikibaseSearchEntities, { query: 'x', language: 'en|de|fr' })).toThrow();
	});

	it('surfaces upstream errors as upstream_failure via the dispatcher', async () => {
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(new Error('wiki down')) });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			wikibaseSearchEntities,
			ctx,
		)(toolArgs(wikibaseSearchEntities, { query: 'x' }));

		expect(assertStructuredError(result, 'upstream_failure').message).toContain('wiki down');
	});
});
