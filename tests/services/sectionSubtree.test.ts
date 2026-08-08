import { describe, it, expect } from 'vitest';
import type { SectionEntry } from '../../src/services/sectionService.ts';
import { childrenOf } from '../../src/services/sectionSubtree.ts';

const entry = (index: string, level: number, line: string): SectionEntry => ({
	index,
	level,
	line,
	editable: true,
});

// Mirrors en.wikipedia's Japan: History is a level-2 heading with three
// level-3 children, followed by another level-2 heading.
const outline: SectionEntry[] = [
	entry('1', 2, 'Etymology'),
	entry('2', 2, 'History'),
	entry('3', 3, 'Prehistoric to classical history'),
	entry('4', 3, 'Feudal era'),
	entry('5', 3, 'Modern era'),
	entry('6', 2, 'Geography'),
];

describe('childrenOf', () => {
	it('returns the sections nested under a heading', () => {
		expect(childrenOf(outline, '2').map((e) => e.line)).toEqual([
			'Prehistoric to classical history',
			'Feudal era',
			'Modern era',
		]);
	});

	it('stops at the next heading of the same level', () => {
		expect(childrenOf(outline, '6')).toEqual([]);
	});

	it('returns nothing for a leaf section', () => {
		expect(childrenOf(outline, '1')).toEqual([]);
	});

	it('returns nothing for a section that is not in the outline', () => {
		expect(childrenOf(outline, '99')).toEqual([]);
	});

	// A deeper child of a child is still inside the subtree being replaced.
	it('includes grandchildren', () => {
		const deep = [
			entry('1', 2, 'A'),
			entry('2', 3, 'A-1'),
			entry('3', 4, 'A-1-a'),
			entry('4', 2, 'B'),
		];
		expect(childrenOf(deep, '1').map((e) => e.line)).toEqual(['A-1', 'A-1-a']);
	});
});
