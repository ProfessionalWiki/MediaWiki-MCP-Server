import { describe, it, expect } from 'vitest';
import type { ToolContext } from '../../src/runtime/context.js';
import { formatEditComment } from '../../src/wikis/utils.js';
import { fakeContext } from '../helpers/fakeContext.js';

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

	it('returns an empty summary when attribution is off and no comment is given', () => {
		const result = formatEditComment(ctxWithAttribution(false), 'update-page');
		expect(result).toBe('');
	});

	it('treats an empty-string comment like a missing one when attribution is on', () => {
		const result = formatEditComment(ctxWithAttribution(), 'update-page', '');
		expect(result).toBe('Automated edit (via update-page on MediaWiki MCP Server)');
	});

	it('returns an empty summary for an empty-string comment when attribution is off', () => {
		const result = formatEditComment(ctxWithAttribution(false), 'update-page', '');
		expect(result).toBe('');
	});
});
