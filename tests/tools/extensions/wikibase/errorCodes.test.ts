import { describe, it, expect } from 'vitest';
import { classifyError } from '../../../../src/errors/classifyError.ts';
import { extensionErrorVocabulary } from '../../../../src/tools/extensions/index.ts';
import { wikibasePack } from '../../../../src/tools/extensions/wikibase/index.ts';

const vocabulary = extensionErrorVocabulary([wikibasePack]);

function mwnError(code: string): Error {
	return Object.assign(new Error(`API error: ${code}`), { code });
}

describe('Wikibase error codes', () => {
	const cases: [string, string][] = [
		['no-such-entity', 'not_found'],
		['invalid-entity-id', 'invalid_input'],
		['param-illegal', 'invalid_input'],
		['param-missing', 'invalid_input'],
		['invalid-snak', 'invalid_input'],
		['no-such-claim', 'invalid_input'],
		['not-recognized', 'invalid_input'],
		['modification-failed', 'invalid_input'],
		['inconsistent-language', 'invalid_input'],
		['inconsistent-site', 'invalid_input'],
		['no-data', 'invalid_input'],
		['param-invalid', 'invalid_input'],
		['invalid-guid', 'invalid_input'],
		['tags-invalid', 'invalid_input'],
		['failed-modify', 'invalid_input'],
	];

	for (const [code, expected] of cases) {
		it(`classifies ${code} as ${expected}`, () => {
			expect(classifyError(mwnError(code), vocabulary)).toEqual({ category: expected, code });
		});
	}

	// Wikibase numbers this family per expected shape, so the codes cannot be listed.
	it('classifies the not-recognized-* family by its prefix', () => {
		expect(classifyError(mwnError('not-recognized-array'), vocabulary)).toEqual({
			category: 'invalid_input',
			code: 'not-recognized-array',
		});
	});

	it('leaves a code no pack claims to the core fallback', () => {
		expect(classifyError(mwnError('wbsomethingnew'), vocabulary)).toEqual({
			category: 'upstream_failure',
		});
	});

	it('still classifies a core MediaWiki code', () => {
		expect(classifyError(mwnError('badtoken'), vocabulary)).toEqual({
			category: 'authentication',
			code: 'badtoken',
		});
	});
});
