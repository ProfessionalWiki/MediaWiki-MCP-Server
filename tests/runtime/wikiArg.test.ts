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

	// The published URI has to name a wiki this lookup can find, or a client
	// that passes back what resources/list gave it gets "wiki not found".
	it.each([
		['mcp://wikis/wiki-%C3%BC', 'wiki-ü'],
		['mcp://wikis/100%25', '100%'],
		['mcp://wikis/a%2Bb', 'a+b'],
		['mcp://wikis/localhost:8080', 'localhost:8080'],
	])('decodes %s back to the registry key', (uri, key) => {
		expect(normalizeWikiArg(uri)).toBe(key);
	});

	it('passes an undecodable segment through, to miss the registry rather than throw', () => {
		expect(normalizeWikiArg('mcp://wikis/100%')).toBe('100%');
	});
});

describe('buildToolInputSchema', () => {
	it('adds a wiki field to a wiki-scoped tool', () => {
		expect(buildToolInputSchema(getPage).shape).toHaveProperty('wiki');
	});
	it('leaves a non-wiki-scoped tool schema untouched', () => {
		expect(buildToolInputSchema(addWiki).shape).not.toHaveProperty('wiki');
	});
});
