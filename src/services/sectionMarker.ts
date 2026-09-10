import type { TruncationInfo } from '../results/truncation.ts';
import { toOutlineLines, type SectionEntry } from './sectionService.ts';
import { editableChildrenOf } from './sectionSubtree.ts';

/**
 * The `content-truncated` marker for a tool that reads page content, where what
 * the caller can do about a cut body depends on what it asked for.
 *
 * A whole-page read still has sections to narrow to. A section read has already
 * spent that narrowing, so its own subsections are the only narrower target, and
 * where it has none the convention is to say no action remains rather than to
 * name the call that just truncated.
 *
 * Shared by every section-aware read, so the three variants and their wording
 * are decided once. Tools whose content is not sections — a diff, a rendered
 * fragment, a row listing — carry their own remedy, which is theirs alone and
 * belongs with them.
 */
export function sectionContentTruncation({
	entries,
	section,
	itemNoun,
	toolName,
	returnedBytes,
	totalBytes,
}: {
	readonly entries: readonly SectionEntry[];
	readonly section: number | undefined;
	readonly itemNoun: string;
	readonly toolName: string;
	readonly returnedBytes: number;
	readonly totalBytes: number;
}): TruncationInfo {
	const base = {
		reason: 'content-truncated',
		returnedBytes,
		totalBytes,
		itemNoun,
		toolName,
	} as const;

	if (section === undefined) {
		const outline = toOutlineLines(entries);
		// A page whose only entry is the lead has no heading to narrow to, and
		// section 0 of such a page is the page, so naming it returns these same
		// bytes. Not naming get-page "again" keeps the sentence true for a
		// get-pages caller, which never called get-page in the first place.
		if (outline.length === 1) {
			return {
				...base,
				remedyHint: 'The page has no sections, so no narrower read returns more of it.',
			};
		}
		return {
			...base,
			sections: outline,
			remedyHint: 'To read a specific section, call get-page with section=N.',
		};
	}

	const subsections = editableChildrenOf(entries, String(section));
	if (subsections.length === 0) {
		return {
			...base,
			remedyHint:
				"No narrower read returns more of this section. To add to it without resending it, use update-page with mode='append'.",
		};
	}
	return {
		...base,
		sections: subsections.map((s) => `${s.index} (${s.line})`),
		remedyHint:
			'To read part of this section, call get-page again with one of the subsection numbers listed.',
	};
}
