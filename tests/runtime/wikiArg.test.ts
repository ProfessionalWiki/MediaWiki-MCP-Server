import { describe, it, expect } from 'vitest';
import { normalizeWikiArg, buildToolInputSchema } from '../../src/runtime/wikiArg.js';
import { getPage } from '../../src/tools/get-page.js';
import { addWiki } from '../../src/tools/add-wiki.js';

describe('normalizeWikiArg', () => {
	it('passes a bare key through', () => {
		expect(normalizeWikiArg('en.wikipedia.org')).toBe('en.wikipedia.org');
	});
	it('strips the mcp://wikis/ prefix', () => {
		expect(normalizeWikiArg('mcp://wikis/fr.wikipedia.org')).toBe('fr.wikipedia.org');
	});
	it('trims surrounding whitespace', () => {
		expect(normalizeWikiArg('  de.wikipedia.org  ')).toBe('de.wikipedia.org');
	});
});

describe('buildToolInputSchema', () => {
	it('adds a wiki field to a wiki-scoped tool', () => {
		expect(buildToolInputSchema(getPage)).toHaveProperty('wiki');
	});
	it('leaves a non-wiki-scoped tool schema untouched', () => {
		expect(buildToolInputSchema(addWiki)).not.toHaveProperty('wiki');
	});
});
