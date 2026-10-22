import type { Mwn } from 'mwn';
import { contentMaxBytes } from '../results/truncation.ts';
import type { EditTarget } from './pageEdit.ts';

// A target larger than one read cannot have been read whole, so a shorter
// source would delete bytes the caller never saw.
export async function unreadContentError(
	{
		title,
		section,
		latestId,
		removeUnreadContent,
	}: EditTarget & { readonly removeUnreadContent?: boolean },
	source: string,
	mwn: Mwn,
): Promise<string | undefined> {
	if (removeUnreadContent === true) {
		return undefined;
	}
	const cap = contentMaxBytes();
	// prop=info, unlike mwn.read, resolves no redirect, so it measures the page
	// this write lands on.
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'info',
			titles: title,
			formatversion: '2',
		})) as { query?: { pages?: { length?: number }[] } } | undefined;
	const pageBytes = response?.query?.pages?.[0]?.length;
	// No section of a page within the cap can exceed it. A page with no length
	// is one the edit itself will refuse, with a better error than this one.
	if (pageBytes === undefined || pageBytes <= cap) {
		return undefined;
	}
	const sourceBytes = Buffer.byteLength(source, 'utf8');
	if (section === undefined) {
		return sourceBytes < pageBytes
			? unreadContentMessage(`Page "${title}"`, pageBytes, sourceBytes, cap)
			: undefined;
	}
	// The write resolves the section number against latestId, so the section is
	// measured there too. Only the lead, which cannot move, arrives without one.
	const sectionRead =
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
	const current = sectionRead?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
	// A section the revision does not have is the edit's own error to report.
	if (typeof current !== 'string') {
		return undefined;
	}
	const sectionBytes = Buffer.byteLength(current, 'utf8');
	if (sectionBytes <= cap || sourceBytes >= sectionBytes) {
		return undefined;
	}
	return unreadContentMessage(`Section ${section}`, sectionBytes, sourceBytes, cap);
}

function unreadContentMessage(
	target: string,
	targetBytes: number,
	sourceBytes: number,
	cap: number,
): string {
	return `${target} holds ${targetBytes} bytes, more than the ${cap} bytes one read returns, so the ${sourceBytes}-byte source supplied cannot contain all of it and this replace would delete the rest. To change part of it without resending it, use operation='find-replace'. To replace it with something shorter deliberately, pass removeUnreadContent: true.`;
}
