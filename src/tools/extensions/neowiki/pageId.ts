import type { Mwn } from 'mwn';

interface PageInfoResponse {
	query?: { pages?: Array<{ pageid?: number; missing?: boolean; title?: string }> };
}

/** True when exactly one of `title` / `pageId` is provided. */
export function hasOnePageRef(ref: { title?: string; pageId?: number }): boolean {
	return (ref.title === undefined) !== (ref.pageId === undefined);
}

/**
 * Resolves a page reference to a numeric page id. A passed `pageId` is returned
 * as-is (no API call); a `title` is resolved via the action API. Returns `null`
 * when the title does not exist. Callers should validate the reference with
 * `hasOnePageRef` first; with that guard, `null` means "title not found".
 */
export async function resolvePageId(
	mwn: Mwn,
	ref: { title?: string; pageId?: number },
): Promise<number | null> {
	if (ref.pageId !== undefined) {
		return ref.pageId;
	}
	if (ref.title === undefined) {
		return null;
	}
	const info = (await mwn.request({
		action: 'query',
		titles: ref.title,
		formatversion: 2,
		format: 'json',
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=query info response shape; trusted at this boundary
	})) as PageInfoResponse;
	const page = info.query?.pages?.[0];
	if (page === undefined || page.missing === true || typeof page.pageid !== 'number') {
		return null;
	}
	return page.pageid;
}
