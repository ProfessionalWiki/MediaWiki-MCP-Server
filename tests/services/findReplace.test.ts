import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { assertStructuredError } from '../helpers/structuredResult.ts';
import { ResponseFormatterImpl } from '../../src/results/response.ts';
import { findReplaceSplice } from '../../src/services/findReplace.ts';

function pageHolding(content: string): object {
	return { pageid: 5, title: 'My Page', revisions: [{ revid: 41, content }] };
}

// The refusal of a splice into `page`, the target as the wiki returns it.
async function refusal(page: object, find: string, replaceWith: string): Promise<CallToolResult> {
	const mwn = { request: vi.fn().mockResolvedValue({ query: { pages: [page] } }) };
	const splice = await findReplaceSplice(
		{ title: 'My Page' },
		{ find, replaceWith },
		new ResponseFormatterImpl(),
		mwn as never,
	);
	if (!('refusal' in splice)) {
		throw new Error('The splice was not refused');
	}
	return splice.refusal;
}

describe('findReplaceSplice', () => {
	it('refuses an invalid title as invalid input', async () => {
		const result = await refusal(
			{ title: 'Bad|Title', invalidreason: 'contains |', invalid: true },
			'a',
			'b',
		);

		assertStructuredError(result, 'invalid_input');
	});

	it('refuses a revision whose text is hidden as permission denied', async () => {
		const result = await refusal(
			{
				pageid: 5,
				title: 'My Page',
				revisions: [{ revid: 41, slots: { main: { texthidden: true } } }],
			},
			'a',
			'b',
		);

		assertStructuredError(result, 'permission_denied');
	});

	it('reports the replacement already present when replaceWith is as long as find', async () => {
		const result = await refusal(pageHolding('Founded in 1105.'), '1104', '1105');

		expect(assertStructuredError(result, 'invalid_input').message).toContain('already present');
	});

	it('does not report the replacement already present when replaceWith occurs more than once', async () => {
		const result = await refusal(pageHolding('Founded in 1105, rebuilt in 1105.'), '1104', '1105');

		expect(assertStructuredError(result, 'invalid_input').message).not.toContain('already present');
	});
});
