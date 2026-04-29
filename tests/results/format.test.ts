import { describe, it, expect } from 'vitest';
import { formatPayload } from '../../src/results/format.js';

describe('formatPayload unknown values', () => {
	it('does not emit bare [object Object] for class instances', () => {
		class Sample {
			value = 1;
		}
		const result = formatPayload({ sample: new Sample() });
		expect(result).not.toContain('[object Object]');
	});
});
