import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unreadContentError } from '../../src/services/unreadContentGuard.ts';

// A wiki holding a page of `pageBytes` bytes whose section reads back as `sectionContent`.
function wikiHolding(pageBytes: number, sectionContent = '') {
	return {
		request: vi.fn(async (params: Record<string, unknown>) =>
			params.prop === 'info'
				? { query: { pages: [{ title: 'My Page', length: pageBytes }] } }
				: { query: { pages: [{ revisions: [{ slots: { main: { content: sectionContent } } }] }] } },
		),
	};
}

describe('unreadContentError', () => {
	beforeEach(() => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('allows a same-size replace of a page too large to have been read', async () => {
		const error = await unreadContentError(
			{ title: 'My Page' },
			'x'.repeat(1001),
			wikiHolding(1001) as never,
		);

		expect(error).toBeUndefined();
	});

	it('allows a same-size replace of a section too large to have been read', async () => {
		const error = await unreadContentError(
			{ title: 'My Page', section: 1, latestId: 41 },
			'x'.repeat(1001),
			wikiHolding(5000, 'y'.repeat(1001)) as never,
		);

		expect(error).toBeUndefined();
	});

	it('allows a shortening replace of a section at exactly the cap', async () => {
		const error = await unreadContentError(
			{ title: 'My Page', section: 1, latestId: 41 },
			'x',
			wikiHolding(5000, 'y'.repeat(1000)) as never,
		);

		expect(error).toBeUndefined();
	});

	it('refuses a shortening replace of a section one byte over the cap', async () => {
		const error = await unreadContentError(
			{ title: 'My Page', section: 1, latestId: 41 },
			'x',
			wikiHolding(5000, 'y'.repeat(1001)) as never,
		);

		expect(error).toContain('Section 1 holds 1001 bytes');
	});
});
