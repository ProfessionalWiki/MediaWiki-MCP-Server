import type { Mwn } from 'mwn';
import type { EditTarget } from './pageEdit.ts';
import { sectionWikitext } from './sectionWikitext.ts';

// Decided from the source's first line, so a write that keeps its heading costs
// no request. An empty source deletes the section, which is a whole edit.
export async function sectionHeadingError(
	{ title, section, latestId }: EditTarget,
	source: string,
	mwn: Mwn,
): Promise<string | undefined> {
	if (section === undefined || section === 0) {
		return undefined;
	}
	if (source.trim() === '' || opensWithHeading(source)) {
		return undefined;
	}
	const current = await sectionWikitext({ title, section, latestId }, mwn);
	// A section the revision does not have is the edit's own error to report.
	if (current === undefined) {
		return undefined;
	}
	const heading = current.split('\n', 1)[0];
	return `Replacing section ${section} replaces its heading too, and source does not begin with one. Begin source with "${heading}" to keep the heading. To remove the heading and keep the text, use operation='find-replace' on the heading line.`;
}

// A heading line opens with `=` and closes with `=`, and only blanks and comments
// may follow. A comment before the marks stops the wiki reading it as a heading.
function opensWithHeading(source: string): boolean {
	const line = source.replace(/^\s*\n/, '').split('\n', 1)[0];
	return line.startsWith('=') && /^=.+=[ \t\r]*$/.test(line.replace(/<!--.*?(?:-->|$)/g, ''));
}
