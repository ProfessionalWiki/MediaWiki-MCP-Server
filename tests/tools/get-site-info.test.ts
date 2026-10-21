import { describe, it, expect, vi, type Mock } from 'vitest';
import { getSiteInfo } from '../../src/tools/get-site-info.ts';
import { contextOn } from '../helpers/fakeContext.ts';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { siteinfoAnswer } from '../helpers/siteinfoAnswer.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.ts';

// The wiki's whole siteinfo; `answering` gives back only what a request asks for.
function siteinfoResponse(
	generalOverrides: Record<string, unknown> = {},
	reported: Record<string, unknown> = {},
) {
	return {
		query: {
			...reported,
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

function answering(response: { query: Record<string, unknown> }): Mock {
	return vi
		.fn()
		.mockImplementation(async (params: Record<string, unknown>) =>
			siteinfoAnswer(response.query, params),
		);
}

function ctxWith(request: Mock) {
	const mwn = createMockMwn({ request });
	return contextOn(mwn);
}

describe('get-site-info', () => {
	it('returns the curated static set', async () => {
		const request = answering(
			siteinfoResponse(
				{},
				{
					extensions: [{ name: 'VisualEditor' }, { name: 'Cargo' }],
					rightsinfo: { url: 'https://x/license', text: 'CC BY-SA 4.0' },
				},
			),
		);
		const ctx = ctxWith(request);

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
		const request = answering(siteinfoResponse());
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
		const request = answering(resp);
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.namespaces['10'].case).toBe('case-sensitive');
	});

	it('includes readonlyreason only when readonly', async () => {
		const request = answering(siteinfoResponse({ readonly: true, readonlyreason: 'maintenance' }));
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.general.readonly).toBe(true);
		expect(data.general.readonlyreason).toBe('maintenance');
	});

	it('omits the license when the wiki has none', async () => {
		const request = answering(siteinfoResponse({}, { rightsinfo: { url: '', text: '' } }));
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
		const request = answering(resp);
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.namespaces['10'].aliases).toEqual(['T', 'Tpl']);
	});

	it('omits statistics by default', async () => {
		const request = answering(siteinfoResponse());
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(getSiteInfo, ctx)({} as never));

		expect(data.statistics).toBeUndefined();
	});

	it('fetches statistics live, in the same request, when includeStatistics is true', async () => {
		const request = answering(
			siteinfoResponse(
				{},
				{
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
			),
		);
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
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('fails with upstream_failure when the siteinfo response lacks general data', async () => {
		const request = vi.fn().mockResolvedValue({ query: {} });
		const ctx = ctxWith(request);

		const result = await dispatch(getSiteInfo, ctx)({} as never);

		assertStructuredError(result, 'upstream_failure');
	});
});
