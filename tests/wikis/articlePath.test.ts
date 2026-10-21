import { describe, it, expect } from 'vitest';
import { normalizeArticlePath } from '../../src/wikis/articlePath.ts';

describe('normalizeArticlePath', () => {
	it('drops a trailing /$1', () => {
		expect(normalizeArticlePath('/wiki/$1')).toBe('/wiki');
	});

	it('keeps the $1 of a query-string article path', () => {
		expect(normalizeArticlePath('/w/index.php?title=$1')).toBe('/w/index.php?title=$1');
	});

	it('keeps a /$1 that does not end the article path', () => {
		expect(normalizeArticlePath('/$1.html')).toBe('/$1.html');
	});
});
