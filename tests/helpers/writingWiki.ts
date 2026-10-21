import { vi } from 'vitest';
import { Mwn } from 'mwn';
import type { ToolContext } from '../../src/runtime/context.ts';
import { EditServiceImpl } from '../../src/services/editService.ts';
import { fakeContext, contextOn } from './fakeContext.ts';

export interface WritingWiki {
	mwn: Mwn;
	sentWrite: () => URLSearchParams;
}

// A real Mwn with only its HTTP layer stubbed, so mwn's own parameter handling
// runs and the assertions see the write as the wiki receives it, including any
// default mwn adds on the way. It hands out a CSRF token, answers a rights query
// with `rights` and any other query with `read`, and answers the write with
// `response`. mwn sends a query as a GET and every other action as a POST.
export function writingWiki(
	response: object,
	wiki: { rights?: string[]; read?: object } = {},
): WritingWiki {
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	let writeBody: string | undefined;
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: {
		params?: Record<string, string>;
		data?: string;
	}) => {
		if (request.params?.meta === 'tokens') {
			return { data: { query: { tokens: { csrftoken: 'csrf-token' } } } };
		}
		if (request.params?.meta === 'userinfo') {
			return { data: { query: { userinfo: { rights: wiki.rights ?? [] } } } };
		}
		if (request.data === undefined) {
			return { data: wiki.read ?? {} };
		}
		writeBody = request.data;
		return { data: response };
	}) as never);
	return {
		mwn,
		sentWrite: () => {
			if (writeBody === undefined) {
				throw new Error('No write reached the wiki');
			}
			return new URLSearchParams(writeBody);
		},
	};
}

/** A context writing to `wiki` through the real edit service, on a wiki configured with `tags`. */
export function contextWritingTo(wiki: WritingWiki, tags: string | null = null): ToolContext {
	const base = fakeContext();
	const activeWiki = {
		...base.activeWiki,
		get: () => {
			const { key, config } = base.activeWiki.get();
			return { key, config: { ...config, tags } };
		},
	};
	return contextOn(wiki.mwn, {
		activeWiki,
		edit: new EditServiceImpl(activeWiki),
	});
}
