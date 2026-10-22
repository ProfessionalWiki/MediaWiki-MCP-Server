import type { Mwn } from 'mwn';
import type { EditTarget } from './pageEdit.ts';
import type { SectionService } from './sectionService.ts';
import { editableChildrenOf } from './sectionSubtree.ts';

// Replacing a section replaces its subsections too. Headings are counted, not
// matched by text, so a source that renames a subsection passes.
export async function subsectionRemovalError(
	{
		title,
		section,
		latestId,
		removeSubsections,
	}: EditTarget & { readonly removeSubsections?: boolean },
	source: string,
	sections: SectionService,
	mwn: Mwn,
): Promise<string | undefined> {
	if (section === undefined || removeSubsections === true) {
		return undefined;
	}
	// The lead has no heading and cannot contain a subsection.
	if (section === 0) {
		return undefined;
	}
	// At latestId, the revision the write resolves the section number against.
	const entries = await sections.list(mwn, title, latestId);
	const index = String(section);
	const children = editableChildrenOf(entries, index);
	if (children.length === 0) {
		return undefined;
	}
	const parent = entries.find((e) => e.index === index);
	if (parent === undefined) {
		return undefined;
	}
	// Headings a template in source expands to are not ones the caller wrote.
	const sourceSections = await sections.listInSource(mwn, title, source);
	const carriedBack = sourceSections.filter((e) => e.editable && e.level > parent.level).length;
	if (carriedBack >= children.length) {
		return undefined;
	}
	const names = children.map((c) => c.line).join(', ');
	return `Section ${index} (${parent.line}) contains ${children.length} subsection${children.length === 1 ? '' : 's'}: ${names}. The source supplied would remove them. Include them in source to keep them, or pass removeSubsections: true to remove them deliberately.`;
}
