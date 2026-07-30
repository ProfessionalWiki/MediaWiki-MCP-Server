import { describe, it, expect } from 'vitest';
import { formatPayload } from '../../src/results/format.ts';

describe('formatPayload unknown values', () => {
	it('does not emit bare [object Object] for class instances', () => {
		class Sample {
			value = 1;
		}
		const result = formatPayload({ sample: new Sample() });
		expect(result).not.toContain('[object Object]');
	});
});

describe('formatPayload multi-line values', () => {
	it('separates a multi-line value from the field that follows it', () => {
		const result = formatPayload({ content: 'first\nsecond', revision: 42 });

		// Without the blank line the next label is the only cue the value ended.
		expect(result).toContain('second\n\nRevision: 42');
	});

	it('keeps a line inside a value from reading as a field of the payload', () => {
		// A page whose own wikitext contains "Summary: …" must not appear to carry a
		// Summary field. The blank line is what makes the boundary readable.
		const result = formatPayload({ content: 'intro\nSummary: not a field', revision: 7 });

		// Assert the boundary exists before slicing on it: indexOf returning -1 would
		// make slice(-1) yield one character, and the check below would pass vacuously.
		const boundary = result.indexOf('\n\nRevision:');
		expect(boundary).toBeGreaterThan(0);
		expect(result.slice(boundary)).not.toContain('Summary:');
	});
});
