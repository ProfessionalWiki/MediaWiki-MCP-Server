import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { contextOn } from '../helpers/fakeContext.ts';
import { getRandomPages } from '../../src/tools/get-random-pages.ts';
import { RedirectFilter } from '../../src/tools/get-links-here.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

type Args = Parameters<typeof getRandomPages.handle>[0];

function args(overrides: Partial<Args> = {}): Args {
	return {
		namespace: 0,
		filter: RedirectFilter.nonredirects,
		limit: 10,
		...overrides,
	};
}

describe('get-random-pages', () => {
	it('defaults to 10 non-redirect pages from the main namespace', () => {
		expect(z.object(getRandomPages.inputSchema).parse({})).toEqual(args());
	});

	it('calls action=query&list=random with namespace, filter and limit', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { random: [] } }),
		});
		const ctx = contextOn(mock);

		await getRandomPages.handle(
			args({ namespace: 14, filter: RedirectFilter.all, limit: 500 }),
			ctx,
		);

		const call = mock.request.mock.calls[0][0];
		expect(call).toMatchObject({
			action: 'query',
			list: 'random',
			rnnamespace: 14,
			rnfilterredir: 'all',
			rnlimit: 500,
		});
	});

	it('returns titles and page IDs without a truncation marker', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					random: [
						{ id: 7, ns: 0, title: 'Alpha' },
						{ id: 42, ns: 0, title: 'Beta' },
					],
				},
				continue: { rncontinue: '0.1|0.2|0|0', continue: '-||' },
			}),
		});
		const ctx = contextOn(mock);

		const result = await getRandomPages.handle(args(), ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('- Title: Alpha');
		expect(text).toContain('  Page ID: 7');
		expect(text).toContain('- Title: Beta');
		expect(text).toContain('  Page ID: 42');
		expect(text).not.toContain('Truncation:');
	});

	it('returns an empty results array when the namespace has no pages', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { random: [] } }),
		});
		const ctx = contextOn(mock);

		const result = await getRandomPages.handle(args({ namespace: 3000 }), ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Results: (none)');
	});

	it('surfaces errors as isError results via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = contextOn(mock);

		const result = await dispatch(getRandomPages, ctx)(args());

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});
});
