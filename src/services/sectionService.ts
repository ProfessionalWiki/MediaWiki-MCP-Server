import type { Mwn } from 'mwn';

export interface SectionEntry {
	/** MediaWiki's own section id, as sent to `section=`. Non-numeric when transcluded. */
	index: string;
	/** Heading depth as an `=` count, 2..6, from the API's `level`. */
	level: number;
	/** Heading text. */
	line: string;
	/** False when the section is transcluded and cannot be edited on this page. */
	editable: boolean;
}

export interface SectionService {
	list(mwn: Mwn, title: string): Promise<SectionEntry[]>;
	listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]>;
}

interface PageSectionsApi {
	index?: string;
	level?: string;
	line?: string;
}

// The API reports `index` as `T-1`, `T-2`, … for sections that arrive by
// transclusion. Those cannot be edited on the host page, and their presence
// shifts every later entry's position away from its section number.
function isEditableIndex(index: string): boolean {
	return /^[1-9]\d*$/.test(index);
}

export class SectionServiceImpl implements SectionService {
	public async list(mwn: Mwn, title: string): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			page: title,
			prop: 'sections',
			formatversion: '2',
		});
	}

	// Parses `source` the way the wiki itself will when an edit lands, so the
	// sections found here agree with the outline `list` reports for the page —
	// one parser decides what counts as a heading on both sides. `title` gives
	// templates in the source their page context.
	public async listInSource(mwn: Mwn, title: string, source: string): Promise<SectionEntry[]> {
		return this.parseSections(mwn, {
			action: 'parse',
			text: source,
			title,
			contentmodel: 'wikitext',
			prop: 'sections',
			formatversion: '2',
		});
	}

	private async parseSections(mwn: Mwn, params: Record<string, string>): Promise<SectionEntry[]> {
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await mwn.request(params)) as { parse?: { sections?: PageSectionsApi[] } } | undefined;
		return (response?.parse?.sections ?? []).map((s) => {
			const index = s.index ?? '';
			return {
				index,
				level: Number.parseInt(s.level ?? '', 10) || 0,
				line: s.line ?? '',
				editable: isEditableIndex(index),
			};
		});
	}
}

// The outline shape tools publish today: the lead as an empty first entry, then
// one heading line per section. Kept separate from the service so the richer
// entries are available internally without changing any tool's output.
export function toOutlineLines(entries: readonly SectionEntry[]): string[] {
	return ['', ...entries.map((e) => e.line)];
}
