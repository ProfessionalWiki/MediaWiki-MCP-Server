import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getLinksHere, LinkType, RedirectFilter } from '../../src/tools/get-links-here.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredData,
	assertStructuredError,
	assertStructuredSuccess,
} from '../helpers/structuredResult.js';

// The SDK applies zod defaults in production; a direct handle() call does not,
// and handle()'s arg type (zod output) makes defaulted fields required. This
// helper supplies resolved defaults so each test overrides only what it tests.
function args(
	overrides: Partial<Parameters<typeof getLinksHere.handle>[0]> = {},
): Parameters<typeof getLinksHere.handle>[0] {
	return {
		title: 'Foo',
		type: LinkType.wikilinks,
		filter: RedirectFilter.all,
		expandRedirects: true,
		...overrides,
	} as Parameters<typeof getLinksHere.handle>[0];
}

describe('get-links-here', () => {
	it('queries list=backlinks with bltitle for wikilinks', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue({ query: { backlinks: [{ pageid: 1, ns: 0, title: 'A' }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ title: 'Target', expandRedirects: false }), ctx);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'query',
			list: 'backlinks',
			bltitle: 'Target',
			formatversion: '2',
		});
	});

	it('routes type=transclusions to list=embeddedin', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { embeddedin: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ title: 'Tmpl', type: LinkType.transclusions }), ctx);

		expect(mock.request.mock.calls[0][0]).toMatchObject({ list: 'embeddedin', eititle: 'Tmpl' });
	});

	it('routes type=fileusage to list=imageusage', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { imageusage: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(
			args({ title: 'File:Bar.png', type: LinkType.fileusage, expandRedirects: false }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			list: 'imageusage',
			iutitle: 'File:Bar.png',
		});
	});

	it('forwards namespaces and a non-all filter with the module prefix', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(
			args({ namespaces: [0, 6], filter: RedirectFilter.redirects, expandRedirects: false }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			blnamespace: '0|6',
			blfilterredir: 'redirects',
		});
	});

	it('omits filterredir when filter is all', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ filter: RedirectFilter.all, expandRedirects: false }), ctx);

		expect(mock.request.mock.calls[0][0]).not.toHaveProperty('blfilterredir');
	});

	it('flattens redirlinks into indirect entries tagged with via when expandRedirects is on', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					backlinks: [
						{ pageid: 1, ns: 0, title: 'Direct' },
						{
							pageid: 2,
							ns: 0,
							title: 'Old Name',
							redirect: true,
							redirlinks: [{ pageid: 3, ns: 0, title: 'Via Old Name' }],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getLinksHere.handle(args({ expandRedirects: true }), ctx);

		expect(mock.request.mock.calls[0][0]).toMatchObject({ blredirect: true });
		const text = assertStructuredSuccess(result);
		expect(text).toContain('Title: Direct');
		expect(text).toContain('Title: Old Name');
		expect(text).toContain('Redirect: true');
		expect(text).toContain('Title: Via Old Name');
		expect(text).toContain('Via: Old Name');
	});

	it('sends no redirect param for transclusions and yields no indirect entries', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue({ query: { embeddedin: [{ pageid: 1, ns: 0, title: 'User:Bob' }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getLinksHere.handle(
			args({ type: LinkType.transclusions, expandRedirects: true }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).not.toHaveProperty('eiredirect');
		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Via:');
	});

	it('clamps the per-level limit to 250 when expandRedirects is on', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ limit: 500, expandRedirects: true }), ctx);

		expect(mock.request.mock.calls[0][0].bllimit).toBe(250);
	});

	it('sends the full requested limit when expansion is off', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ limit: 500, expandRedirects: false }), ctx);

		expect(mock.request.mock.calls[0][0].bllimit).toBe(500);
	});

	it('forwards continueFrom as the module continue param', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getLinksHere.handle(args({ continueFrom: '0|999', expandRedirects: false }), ctx);

		expect(mock.request.mock.calls[0][0].blcontinue).toBe('0|999');
	});

	it('attaches a more-available truncation with the continueFrom cursor', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: { backlinks: [{ pageid: 1, ns: 0, title: 'A' }] },
				continue: { blcontinue: '0|123' },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getLinksHere.handle(args({ expandRedirects: false }), ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('  Reason: more-available');
		expect(text).toContain('  Item noun: links');
		expect(text).toContain('  Tool name: get-links-here');
		expect(text).toContain('    Param: continueFrom');
		expect(text).toContain('    Value: 0|123');
	});

	it('returns an empty list without error when the target has no references', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { backlinks: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getLinksHere.handle(
			args({ title: 'Nonexistent', expandRedirects: false }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
		expect(text).not.toContain('Title:');
	});

	it('surfaces upstream errors as isError via the dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API boom')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(getLinksHere, ctx)(args());

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API boom');
	});

	it('omits the redirect flag when false', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					backlinks: [
						{ pageid: 1, ns: 0, title: 'Plain', redirect: false },
						{
							pageid: 2,
							ns: 0,
							title: 'Redir',
							redirect: true,
							redirlinks: [{ pageid: 3, ns: 0, title: 'Via', redirect: false }],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const data = assertStructuredData(
			await dispatch(getLinksHere, ctx)({ title: 'T', type: 'wikilinks' } as never),
		);
		const links = data.links as Record<string, unknown>[];
		const plain = links.find((l) => l.title === 'Plain')!;
		const redir = links.find((l) => l.title === 'Redir')!;
		const via = links.find((l) => l.title === 'Via')!;
		expect(plain).not.toHaveProperty('redirect');
		expect(plain).toMatchObject({ title: 'Plain', pageId: 1, namespace: 0 });
		expect(redir).toHaveProperty('redirect', true);
		expect(via).not.toHaveProperty('redirect');
		expect(via).toHaveProperty('via', 'Redir');
	});
});
