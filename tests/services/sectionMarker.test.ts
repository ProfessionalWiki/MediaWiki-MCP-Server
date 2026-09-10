import { describe, it, expect } from 'vitest';
import { sectionContentTruncation } from '../../src/services/sectionMarker.ts';
import type { SectionEntry } from '../../src/services/sectionService.ts';

const OUTLINE: SectionEntry[] = [
	{ index: '1', level: 2, line: 'History', editable: true },
	{ index: '2', level: 3, line: 'Origins', editable: true },
	{ index: '3', level: 3, line: 'Modern era', editable: true },
	{ index: '4', level: 2, line: 'Geography', editable: true },
];

function marker(section: number | undefined, entries: SectionEntry[] = OUTLINE) {
	return sectionContentTruncation({
		entries,
		section,
		itemNoun: 'wikitext',
		toolName: 'get-page',
		returnedBytes: 50000,
		totalBytes: 60000,
	});
}

describe('sectionContentTruncation', () => {
	it('offers the page outline when the read was not narrowed', () => {
		const info = marker(undefined);

		expect(info).toMatchObject({
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 60000,
			sections: ['0 (Lead)', '1 (History)', '2 (Origins)', '3 (Modern era)', '4 (Geography)'],
		});
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain('section=N');
	});

	// Naming the whole page's sections is what sent a caller back to the call it
	// had just made, so a narrowed read offers only what is nested under it.
	it("offers the requested section's subsections when the read was narrowed", () => {
		const info = marker(1);

		expect(info).toMatchObject({ sections: ['2 (Origins)', '3 (Modern era)'] });
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain('subsection numbers');
	});

	it('reports that no narrower read exists for a section without subsections', () => {
		const info = marker(4);

		expect(info).not.toHaveProperty('sections');
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain(
			'No narrower read returns more of this section',
		);
	});

	// The lead carries no heading, so the outline holds no entry to nest under.
	it('reports that no narrower read exists for the lead', () => {
		const info = marker(0);

		expect(info).not.toHaveProperty('sections');
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain(
			'No narrower read returns more of this section',
		);
	});

	// Section 0 of a page with no headings is the page, so naming it returns the
	// same bytes: the narrowing is exhausted here too.
	it('reports that no narrower read exists for a page with no sections', () => {
		const info = marker(undefined, []);

		expect(info).not.toHaveProperty('sections');
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain(
			'The page has no sections',
		);
	});

	it('reports that no narrower read exists for a page whose headings are all transcluded', () => {
		const info = marker(undefined, [
			{ index: 'T-1', level: 2, line: 'From a template', editable: false },
		]);

		expect(info).not.toHaveProperty('sections');
		expect(info.reason === 'content-truncated' && info.remedyHint).toContain(
			'The page has no sections',
		);
	});

	// formatPayload renders a field value over 120 characters as its own
	// unindented block, which lifts the sentence out of the marker it belongs to.
	it.each([undefined, 1, 4])('keeps the remedy inline at section=%s', (section) => {
		const info = marker(section);

		expect(info.reason === 'content-truncated' && info.remedyHint.length).toBeLessThanOrEqual(120);
	});

	it('leaves a transcluded subsection out of the narrower targets it offers', () => {
		const info = marker(1, [
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: 'T-1', level: 3, line: 'From a template', editable: false },
			{ index: '2', level: 3, line: 'Origins', editable: true },
		]);

		expect(info).toMatchObject({ sections: ['2 (Origins)'] });
	});
});
