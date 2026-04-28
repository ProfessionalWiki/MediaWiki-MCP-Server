import { describe, it, expect } from 'vitest';
import type { ErrorCategory } from '../../src/errors/classifyError.js';
import { classifyError } from '../../src/errors/classifyError.js';
import { errorResult } from '../../src/results/response.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { assertStructuredError } from '../helpers/structuredResult.js';

describe('classifyError', () => {
	describe('maps MW .code to category', () => {
		const cases: Array<[string, ErrorCategory]> = [
			['missingtitle', 'not_found'],
			['nosuchrevid', 'not_found'],
			['nosuchsection', 'not_found'],
			['nofile', 'not_found'],
			['permissiondenied', 'permission_denied'],
			['protectedpage', 'permission_denied'],
			['protectedtitle', 'permission_denied'],
			['cascadeprotected', 'permission_denied'],
			['cantcreate', 'permission_denied'],
			['readapidenied', 'permission_denied'],
			['writeapidenied', 'permission_denied'],
			['blocked', 'permission_denied'],
			['abusefilter-disallowed', 'permission_denied'],
			['abusefilter-warning', 'permission_denied'],
			['invalidtitle', 'invalid_input'],
			['invalidparammix', 'invalid_input'],
			['badvalue', 'invalid_input'],
			['baddatatype', 'invalid_input'],
			['paramempty', 'invalid_input'],
			['badtags', 'invalid_input'],
			['editconflict', 'conflict'],
			['articleexists', 'conflict'],
			['fileexists', 'conflict'],
			['fileexists-no-change', 'conflict'],
			['notloggedin', 'authentication'],
			['badtoken', 'authentication'],
			['mustbeloggedin', 'authentication'],
			['assertuserfailed', 'authentication'],
			['assertbotfailed', 'authentication'],
			['ratelimited', 'rate_limited'],
			['readonly', 'upstream_failure'],
		];

		for (const [code, expectedCategory] of cases) {
			it(`${code} → ${expectedCategory}`, () => {
				const err = createMockMwnError(code);
				expect(classifyError(err)).toEqual({
					category: expectedCategory,
					code,
				});
			});
		}
	});

	it('maps internal_api_error_* codes to upstream_failure', () => {
		const err = createMockMwnError('internal_api_error_DBQueryError');
		expect(classifyError(err)).toEqual({
			category: 'upstream_failure',
			code: 'internal_api_error_DBQueryError',
		});
	});

	it('falls back to upstream_failure for unknown codes', () => {
		const err = createMockMwnError('somethingnew', 'A new kind of error');
		expect(classifyError(err)).toEqual({ category: 'upstream_failure' });
	});

	it('regex fallback picks up codes embedded in message when .code is absent', () => {
		const err = new Error('The API returned: missingtitle — page not present');
		expect(classifyError(err)).toEqual({
			category: 'not_found',
			code: 'missingtitle',
		});
	});

	it('prefers .code over message regex when both are present', () => {
		const err = createMockMwnError('ratelimited', 'something about missingtitle in the message');
		expect(classifyError(err)).toEqual({
			category: 'rate_limited',
			code: 'ratelimited',
		});
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['string', 'oops'],
		['plain object without code', {}],
		['number', 42],
	])('non-Error value (%s) → upstream_failure without code', (_label, value) => {
		expect(classifyError(value)).toEqual({ category: 'upstream_failure' });
	});
});

describe('errorResult', () => {
	it('builds a structured envelope with isError', () => {
		const result = errorResult('not_found', 'Page "Foo" not found');
		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toBe('Page "Foo" not found');
		expect(envelope.code).toBeUndefined();
	});

	it('preserves the full message in the envelope', () => {
		const result = errorResult('upstream_failure', 'Failed to fetch: connection refused');
		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toBe('Failed to fetch: connection refused');
	});

	it('carries an optional MediaWiki error code', () => {
		const result = errorResult('conflict', 'clash', 'editconflict');
		assertStructuredError(result, 'conflict', 'editconflict');
	});
});
