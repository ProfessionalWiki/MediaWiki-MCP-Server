import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { ResponseFormatter } from '../results/response.ts';
import { readPage } from '../wikis/readPage.ts';
import type { EditTarget } from './pageEdit.ts';

type Splice =
	| { readonly text: string; readonly baseRevisionId: number | undefined }
	| { readonly refusal: CallToolResult };

export async function findReplaceSplice(
	{ title, section, latestId }: EditTarget,
	{ find, replaceWith }: { readonly find: string; readonly replaceWith: string },
	format: ResponseFormatter,
	mwn: Mwn,
): Promise<Splice> {
	const page = await readPage(mwn, title, {
		rvprop: 'ids|content',
		// The edit goes to the title named, so the read must not follow a redirect.
		redirects: false,
		...(section !== undefined ? { rvsection: section } : {}),
	});
	if (page.missing) {
		return { refusal: format.notFound(`Page "${title}" not found`) };
	}
	if (page.invalid) {
		return { refusal: format.invalidInput(`"${title}" is not a valid page title`) };
	}
	const rev = page.revisions?.[0];
	const current = rev?.content;
	if (typeof current !== 'string') {
		// The API answers each of these with an empty slot rather than an error.
		if (section !== undefined) {
			// Matches what a write reports for nosuchsection.
			return {
				refusal: format.notFound(`Section ${section} does not exist`, 'nosuchsection'),
			};
		}
		// mwn's ApiRevision does not declare texthidden.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		if ((rev as { texthidden?: boolean } | undefined)?.texthidden === true) {
			return {
				refusal: format.permissionDenied(
					`The current revision of "${title}" has its text hidden, so it cannot be read to edit`,
				),
			};
		}
		return {
			refusal: format.error('upstream_failure', `The wiki returned no content for "${title}"`),
		};
	}
	// latestId refuses any newer revision, as on every write, though the splice
	// might survive it.
	if (latestId !== undefined && rev?.revid !== latestId) {
		return {
			refusal: format.conflict(
				`Page "${title}" is at revision ${rev?.revid}, not ${latestId}, so it has been edited since the revision named. Re-read it and send the edit again.`,
			),
		};
	}

	const scope = scopeName(title, section);
	// Exact, never whitespace-tolerant: one leading space turns a wikitext line
	// into a <pre> block.
	const occurrences = occurrenceCount(current, find);
	if (occurrences === 0) {
		// Claimed only for a replaceWith as specific as find and unique, since a
		// false claim costs the caller its change.
		const applied =
			replaceWith.length >= find.length && occurrenceCount(current, replaceWith) === 1
				? ' The text replaceWith names is already present, so this edit may have landed already.'
				: '';
		return {
			refusal: format.invalidInput(
				`No replacement was made: find did not appear in ${scope}.${applied} Read the current wikitext with get-page and copy find from it exactly, whitespace and template markup included.`,
			),
		};
	}
	if (occurrences > 1) {
		return {
			refusal: format.invalidInput(
				`No replacement was made: find appears ${occurrences} times in ${scope}. Extend find with the text around it so it names one occurrence${section === undefined ? ', or set section to search one section only' : ''}.`,
			),
		};
	}

	// By index: String#replace would read `$&` and `$1` in replaceWith.
	const at = current.indexOf(find);
	return {
		text: current.slice(0, at) + replaceWith + current.slice(at + find.length),
		baseRevisionId: rev?.revid,
	};
}

// Counts overlapping matches: a find such as `\n\n` that begins inside its own
// previous match names two different splices.
function occurrenceCount(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		count++;
	}
	return count;
}

function scopeName(title: string, section: number | undefined): string {
	return section === undefined ? `page "${title}"` : `section ${section} of "${title}"`;
}
