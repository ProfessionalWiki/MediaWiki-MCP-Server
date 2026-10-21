import { describe, it, expect } from 'vitest';
import { errorMessage } from '../../src/errors/errorMessage.ts';

describe('errorMessage', () => {
	it("reads an Error's message", () => {
		expect(errorMessage(new Error('wiki unreachable'))).toBe('wiki unreachable');
	});

	it('states a thrown value that is not an Error', () => {
		expect(errorMessage('wiki unreachable')).toBe('wiki unreachable');
	});
});
