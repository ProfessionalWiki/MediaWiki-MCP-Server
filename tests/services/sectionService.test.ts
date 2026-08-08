import { describe, it, expect, vi } from 'vitest';
import { SectionServiceImpl, toOutlineLines } from '../../src/services/sectionService.ts';

function mockWithSections(sections: unknown[]) {
	return {
		request: vi.fn().mockResolvedValue({ parse: { sections } }),
	};
}

describe('SectionServiceImpl', () => {
	it('carries the section id, heading level and text', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'Etymology' },
			{ index: '2', level: '2', line: 'History' },
			{ index: '3', level: '3', line: 'Feudal era' },
		]);

		expect(await new SectionServiceImpl().list(mock as never, 'Japan')).toEqual([
			{ index: '1', level: 2, line: 'Etymology', editable: true },
			{ index: '2', level: 2, line: 'History', editable: true },
			{ index: '3', level: 3, line: 'Feudal era', editable: true },
		]);
	});

	// A transcluded section carries a `T-` prefixed id and cannot be edited on
	// the host page, so a caller must never be handed it as a section number.
	it('marks a transcluded section as not editable', async () => {
		const mock = mockWithSections([
			{ index: 'T-1', level: '2', line: 'About administrators' },
			{ index: '1', level: '2', line: 'Current nominations' },
		]);

		const result = await new SectionServiceImpl().list(mock as never, 'RfA');
		expect(result[0]).toMatchObject({ index: 'T-1', editable: false });
		expect(result[1]).toMatchObject({ index: '1', editable: true });
	});

	it('returns an empty list for a page with no headings', async () => {
		expect(await new SectionServiceImpl().list(mockWithSections([]) as never, 'Empty')).toEqual([]);
	});
});

describe('listInSource', () => {
	it('sends the source to be parsed in the context of the named page', async () => {
		const mock = mockWithSections([]);

		await new SectionServiceImpl().listInSource(mock as never, 'Japan', '== History ==\nBody.');

		expect(mock.request).toHaveBeenCalledWith({
			action: 'parse',
			text: '== History ==\nBody.',
			title: 'Japan',
			contentmodel: 'wikitext',
			prop: 'sections',
			formatversion: '2',
		});
	});

	it('carries the section id, heading level and text', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'History' },
			{ index: '2', level: '3', line: 'Feudal era' },
		]);

		expect(
			await new SectionServiceImpl().listInSource(mock as never, 'Japan', 'irrelevant'),
		).toEqual([
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: '2', level: 3, line: 'Feudal era', editable: true },
		]);
	});

	// A template in the source expands to sections the caller did not write;
	// the parser reports them with `T-` ids, exactly as on a stored page.
	it('marks a template-expanded section as not editable', async () => {
		const mock = mockWithSections([
			{ index: '1', level: '2', line: 'History' },
			{ index: 'T-1', level: '3', line: 'Transcluded child' },
		]);

		const result = await new SectionServiceImpl().listInSource(
			mock as never,
			'Japan',
			'== History ==\n{{Probe}}',
		);

		expect(result[1]).toMatchObject({ index: 'T-1', editable: false });
	});
});

describe('toOutlineLines', () => {
	// The published outline is unchanged by this task: a leading empty string
	// for the lead, then one heading line per section.
	it('renders the lead as an empty first entry', () => {
		expect(
			toOutlineLines([
				{ index: '1', level: 2, line: 'Etymology', editable: true },
				{ index: '2', level: 2, line: 'History', editable: true },
			]),
		).toEqual(['', 'Etymology', 'History']);
	});

	it('renders a page with no headings as the lead alone', () => {
		expect(toOutlineLines([])).toEqual(['']);
	});
});
