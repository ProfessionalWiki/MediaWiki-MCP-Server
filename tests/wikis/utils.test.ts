import { describe, it, expect } from 'vitest';
import type { ToolContext } from '../../src/runtime/context.ts';
import { buildPageUrl, formatEditComment } from '../../src/wikis/utils.ts';
import { fakeContext } from '../helpers/fakeContext.ts';

function ctxWithAttribution(attributeEdits?: boolean): ToolContext {
	return fakeContext({
		activeWiki: {
			get: () =>
				({
					key: 'test-wiki',
					config: {
						sitename: 'Test',
						server: 'https://test.wiki',
						articlepath: '/wiki',
						scriptpath: '/w',
						tags: null,
						attributeEdits,
					},
				}) as never,
			getDefaultKey: () => 'test-wiki',
		},
	});
}

describe('formatEditComment', () => {
	it('appends the attribution suffix to a caller comment by default', () => {
		const result = formatEditComment(ctxWithAttribution(), 'update-page', 'Fix typo');
		expect(result).toBe('Fix typo (via update-page on MediaWiki MCP Server)');
	});

	it('falls back to an attributed "Automated edit" when no comment is given', () => {
		const result = formatEditComment(ctxWithAttribution(), 'update-page');
		expect(result).toBe('Automated edit (via update-page on MediaWiki MCP Server)');
	});

	it('keeps attribution when attributeEdits is explicitly true', () => {
		const result = formatEditComment(ctxWithAttribution(true), 'delete-page', 'Spam');
		expect(result).toBe('Spam (via delete-page on MediaWiki MCP Server)');
	});

	it('omits the suffix and returns the bare comment when attributeEdits is false', () => {
		const result = formatEditComment(ctxWithAttribution(false), 'update-page', 'Fix typo');
		expect(result).toBe('Fix typo');
	});

	it('returns no summary when attribution is off and no comment is given', () => {
		const result = formatEditComment(ctxWithAttribution(false), 'update-page');
		expect(result).toBeUndefined();
	});

	it('treats an empty-string comment like a missing one when attribution is on', () => {
		const result = formatEditComment(ctxWithAttribution(), 'update-page', '');
		expect(result).toBe('Automated edit (via update-page on MediaWiki MCP Server)');
	});

	it('returns no summary for an empty-string comment when attribution is off', () => {
		const result = formatEditComment(ctxWithAttribution(false), 'update-page', '');
		expect(result).toBeUndefined();
	});
});

function ctxWithArticlePath(articlepath: string): ToolContext {
	const ctx = fakeContext();
	ctx.siteInfoCache.set('test-wiki', { server: 'https://test.wiki', articlepath });
	return ctx;
}

describe('buildPageUrl', () => {
	it('appends the title to an article path without a $1 placeholder', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/wiki'), 'List of cities');
		expect(url).toBe('https://test.wiki/wiki/List_of_cities');
	});

	it('puts the title in place of $1 in a query-string article path', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/w/index.php?title=$1'), 'Main Page');
		expect(url).toBe('https://test.wiki/w/index.php?title=Main_Page');
	});

	it('encodes an ampersand so it stays inside the title query value', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/w/index.php?title=$1'), 'AT&T');
		expect(url).toBe('https://test.wiki/w/index.php?title=AT%26T');
	});

	it('encodes a question mark so it stays inside the title path', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/wiki'), 'What?');
		expect(url).toBe('https://test.wiki/wiki/What%3F');
	});

	it('keeps namespace colons and subpage slashes readable', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/wiki'), 'Help:Editing/Tables');
		expect(url).toBe('https://test.wiki/wiki/Help:Editing/Tables');
	});

	it('keeps dollar signs in the title literal', async () => {
		const url = await buildPageUrl(ctxWithArticlePath('/w/index.php?title=$1'), 'Ca$$h');
		expect(url).toBe('https://test.wiki/w/index.php?title=Ca$$h');
	});
});
