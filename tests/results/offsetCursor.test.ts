import { describe, it, expect } from 'vitest';
import { offsetFrom } from '../../src/results/offsetCursor.ts';

describe('offsetFrom', () => {
	it('starts at the first row when no cursor is given', () => {
		expect(offsetFrom(undefined)).toBe(0);
	});

	it('reads the offset a tool handed out', () => {
		expect(offsetFrom('40')).toBe(40);
	});

	it('refuses a negative offset', () => {
		expect(offsetFrom('-1')).toBeUndefined();
	});

	it('refuses a cursor that is not a whole number', () => {
		expect(offsetFrom('1.5')).toBeUndefined();
	});

	it('refuses a cursor that is not a number', () => {
		expect(offsetFrom('next')).toBeUndefined();
	});
});
