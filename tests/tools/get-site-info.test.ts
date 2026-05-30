import { describe, it, expect, vi } from 'vitest';
import { getSiteInfo } from '../../src/tools/get-site-info.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredData } from '../helpers/structuredResult.js';
import type { LicenseInfo } from '../../src/wikis/siteInfoCache.js';

function siteinfoResponse(generalOverrides: Record<string, unknown> = {}) {
	return {
		query: {
			general: {
				sitename: 'Example',
				generator: 'MediaWiki 1.43.0',
				lang: 'en',
				case: 'first-letter',
				readonly: false,
				maxarticlesize: 2097152,
				...generalOverrides,
			},
			namespaces: {
				0: { id: 0, name: '', canonical: '', case: 'first-letter', content: true },
				10: { id: 10, name: 'Template', canonical: 'Template', case: 'first-letter' },
			},
			namespacealiases: [{ id: 10, alias: 'T' }],
		},
	};
}

function ctxWith(
	request: ReturnType<typeof vi.fn>,
	opts: { extensions?: Set<string>; license?: LicenseInfo } = {},
) {
	const mwn = createMockMwn({ request });
	return fakeContext({
		mwn: () => Promise.resolve(mwn as never),
		// Pre-populate so resolveSiteInfo short-circuits (issues no extra request).
		siteInfoCache: {
			get: () => ({
				server: 'https://example',
				articlepath: '/wiki',
				...(opts.license ? { license: opts.license } : {}),
			}),
			set: () => {},
			delete: () => {},
		},
		extensions: {
			has: (async () => false) as never,
			hasAny: (async () => false) as never,
			inspect: (async () => ({
				reachable: true,
				extensions: opts.extensions ?? new Set<string>(),
			})) as never,
			invalidate: (() => {}) as never,
		},
	});
}

describe('get-site-info', () => {
	it('returns the curated static set', async () => {
		const request = vi.fn().mockResolvedValue(siteinfoResponse());
		const ctx = ctxWith(request, {
			extensions: new Set(['VisualEditor', 'Cargo']),
			license: { url: 'https://x/license', title: 'CC BY-SA 4.0' },
		});

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.general).toEqual({
			sitename: 'Example',
			generator: 'MediaWiki 1.43.0',
			lang: 'en',
			case: 'first-letter',
			readonly: false,
			maxarticlesize: 2097152,
		});
		expect(data.extensions).toEqual(['Cargo', 'VisualEditor']);
		expect(data.license).toEqual({ url: 'https://x/license', title: 'CC BY-SA 4.0' });
	});

	it('compacts namespaces: aliases attached, default content/case omitted', async () => {
		const request = vi.fn().mockResolvedValue(siteinfoResponse());
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.namespaces['0']).toEqual({ canonical: '', name: '', content: true });
		expect(data.namespaces['10']).toEqual({
			canonical: 'Template',
			name: 'Template',
			aliases: ['T'],
		});
	});

	it('keeps namespace case only when it differs from general.case', async () => {
		const resp = siteinfoResponse();
		resp.query.namespaces[10].case = 'case-sensitive';
		const request = vi.fn().mockResolvedValue(resp);
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.namespaces['10'].case).toBe('case-sensitive');
	});

	it('includes readonlyreason only when readonly', async () => {
		const request = vi
			.fn()
			.mockResolvedValue(siteinfoResponse({ readonly: true, readonlyreason: 'maintenance' }));
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.general.readonly).toBe(true);
		expect(data.general.readonlyreason).toBe('maintenance');
	});

	it('omits license when resolveSiteInfo returns none', async () => {
		const request = vi.fn().mockResolvedValue(siteinfoResponse());
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.license).toBeUndefined();
	});

	it('accumulates multiple aliases for the same namespace id', async () => {
		const resp = siteinfoResponse();
		resp.query.namespacealiases = [
			{ id: 10, alias: 'T' },
			{ id: 10, alias: 'Tpl' },
		];
		const request = vi.fn().mockResolvedValue(resp);
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.namespaces['10'].aliases).toEqual(['T', 'Tpl']);
	});

	it('omits statistics by default and makes one siteinfo request', async () => {
		const request = vi.fn().mockResolvedValue(siteinfoResponse());
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.statistics).toBeUndefined();
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0].siprop).not.toContain('statistics');
	});

	it('fetches statistics live when includeStatistics is true', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(siteinfoResponse())
			.mockResolvedValueOnce({
				query: {
					statistics: {
						pages: 10,
						articles: 4,
						edits: 99,
						images: 2,
						users: 7,
						activeusers: 3,
						admins: 1,
					},
				},
			});
		const ctx = ctxWith(request);

		const data = assertStructuredData(
			await dispatch(getSiteInfo, ctx)({ includeStatistics: true } as never),
		);

		expect(data.statistics).toEqual({
			pages: 10,
			articles: 4,
			edits: 99,
			images: 2,
			users: 7,
			activeusers: 3,
			admins: 1,
		});
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1][0].siprop).toBe('statistics');
	});
});
