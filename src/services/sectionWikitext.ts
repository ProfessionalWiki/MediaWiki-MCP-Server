import type { Mwn } from 'mwn';
import type { EditTarget } from './pageEdit.ts';

// At latestId, the revision the write resolves the section number against. Only
// the lead, which cannot move, arrives without one.
export async function sectionWikitext(
	{ title, section, latestId }: EditTarget & { readonly section: number },
	mwn: Mwn,
): Promise<string | undefined> {
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'revisions',
			...(latestId === undefined ? { titles: title } : { revids: latestId }),
			rvprop: 'content',
			rvslots: 'main',
			rvsection: section,
			formatversion: '2',
		})) as
			| { query?: { pages?: { revisions?: { slots?: { main?: { content?: string } } }[] }[] } }
			| undefined;
	return response?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
}
