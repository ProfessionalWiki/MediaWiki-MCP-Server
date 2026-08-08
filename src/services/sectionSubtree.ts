import type { SectionEntry } from './sectionService.ts';

/**
 * The sections nested under `index` — those following it with a deeper heading
 * level, up to the first that is not deeper.
 *
 * This is the set MediaWiki replaces along with the section itself:
 * `Parser::extractSections` breaks on `$curLevel <= $targetLevel`, comparing
 * `=` counts, which is why `level` and not `toclevel` is the field consulted.
 */
export function childrenOf(entries: readonly SectionEntry[], index: string): SectionEntry[] {
	const position = entries.findIndex((e) => e.index === index);
	if (position === -1) {
		return [];
	}
	const parentLevel = entries[position].level;
	const children: SectionEntry[] = [];
	for (const entry of entries.slice(position + 1)) {
		if (entry.level <= parentLevel) {
			break;
		}
		children.push(entry);
	}
	return children;
}
