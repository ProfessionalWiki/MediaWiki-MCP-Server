import type { ApiPage, ApiParams, Mwn } from 'mwn';

/**
 * One page's latest revision, with its main slot's fields set on the revision
 * as mwn.read() sets them. Unlike mwn.read(), a refused read fails with the
 * wiki's error: mwn.read() goes through massQuery, which returns a failed batch
 * as data and then trips over it.
 */
export async function readPage(
	mwn: Mwn,
	title: string,
	params: ApiParams & { redirects: boolean },
): Promise<ApiPage> {
	const response = await mwn.request({
		action: 'query',
		titles: title,
		prop: 'revisions',
		rvslots: 'main',
		formatversion: '2',
		...params,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
	const page = (response as { query?: { pages?: ApiPage[] } }).query?.pages?.[0];
	if (page === undefined) {
		throw new Error(`The wiki returned no page for "${title}"`);
	}
	for (const revision of page.revisions ?? []) {
		Object.assign(revision, revision.slots?.main);
	}
	return page;
}

export interface RenderedPage {
	html?: string;
	title?: string;
	pageId?: number;
}

export async function renderPage(
	mwn: Mwn,
	target: { page: string; section?: number } | { oldid: number },
): Promise<RenderedPage> {
	const response = await mwn.request({
		action: 'parse',
		...target,
		prop: 'text',
		formatversion: '2',
	});
	return {
		html: response.parse?.text,
		title: response.parse?.title,
		pageId: response.parse?.pageid,
	};
}
