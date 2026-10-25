import type { Mwn } from 'mwn';
import type { SectionService } from './sectionService.ts';
import type { EditTarget } from './pageEdit.ts';

/**
 * A section replace splices `source` in place of the section's heading and its
 * subtree. Two losses are possible, and both are refused here:
 *
 * - a source that does not open with a heading at the section's level deletes
 *   the heading itself;
 * - a source that carries a later heading at the section's level or higher
 *   places a sibling section inside the replacement, so the page ends up with
 *   two headings of the same name.
 *
 * Both sides are parsed by the wiki itself, so what counts as a heading is
 * decided once — a heading-shaped line inside <nowiki> or a comment is not a
 * section on either side. Headings are counted rather than matched by text, so
 * a rename passes. The nested-subsection check lives in `subsectionGuard.ts`;
 * this guard only judges the heading the caller has to start with.
 */
export async function sectionHeadingError(
	{ title, section, latestId }: EditTarget,
	source: string,
	sections: SectionService,
	mwn: Mwn,
): Promise<string | undefined> {
	// The lead has no heading.
	if (section === undefined || section === 0) {
		return undefined;
	}
	// Read the outline at the revision the write resolves the section number
	// against, when the caller supplied one.
	const entries = await sections.list(mwn, title, latestId);
	const index = String(section);
	const parent = entries.find((entry) => entry.index === index);
	if (parent === undefined) {
		// The wiki reports nosuchsection with a better message than this guard.
		return undefined;
	}
	// Sections a template in the source expands to carry `T-` ids and are
	// excluded: only headings the caller wrote count.
	const sourceSections = await sections.listInSource(mwn, title, source);
	const written = sourceSections.filter((entry) => entry.editable);
	const first = written[0];
	// `byteoffset` counts UTF-8 bytes, while String#slice counts UTF-16 units;
	// decode the byte prefix so a multibyte character before the heading is
	// judged as the text it is, not as a truncated surrogate.
	const prefix =
		first?.byteOffset === undefined || first.byteOffset === 0
			? ''
			: Buffer.from(source, 'utf8').subarray(0, first.byteOffset).toString('utf8');
	if (
		first === undefined ||
		first.level !== parent.level ||
		(first.byteOffset !== undefined && prefix.trim() !== '')
	) {
		const heading = `${'='.repeat(parent.level)} ${parent.line} ${'='.repeat(parent.level)}`;
		return `Section ${index} (${parent.line}) is replaced together with its heading, but the source supplied does not begin with a heading at level ${parent.level}. The heading would be deleted. Start the source with the heading (for example "${heading}"), or with a new heading at the same level to rename the section. To add content without replacing the section, use operation='append'.`;
	}
	const sibling = written.find((entry, position) => position > 0 && entry.level <= parent.level);
	if (sibling !== undefined) {
		return `The source supplied contains a heading at level ${sibling.level} ("${sibling.line}") after the section heading. A section replace writes only inside section ${index}, so that heading would duplicate a sibling section. Remove it from the source, or write the whole page.`;
	}
	return undefined;
}
