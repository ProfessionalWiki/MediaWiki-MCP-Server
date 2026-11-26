import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes } from '../../src/runtime/trailingSlashes.ts';

describe('stripTrailingSlashes', () => {
	it('strips every trailing slash', () => {
		expect(stripTrailingSlashes('https://wiki.example/mcp///')).toBe('https://wiki.example/mcp');
	});

	it('leaves slashes before the end in place', () => {
		expect(stripTrailingSlashes('https://wiki.example//mcp')).toBe('https://wiki.example//mcp');
	});
});
