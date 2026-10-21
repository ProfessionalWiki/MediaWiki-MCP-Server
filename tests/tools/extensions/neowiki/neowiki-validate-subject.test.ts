import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { neowikiValidateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-validate-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

const stmts = { Founded: { propertyType: 'number', value: 2019 } };

describe('neowiki-validate-subject', () => {
	it('validates a new subject against a schema (no CSRF token)', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { violations: [] } }),
		});
		const ctx = contextOn(mock);
		const result = await neowikiValidateSubject.handle(
			{ schema: 'Company', statements: stmts },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/validate');
		expect(JSON.parse(call.data)).toEqual({ schema: 'Company', statements: stmts });
		expect(call.headers['X-CSRF-TOKEN']).toBeUndefined();
		expect(mock.getCsrfToken).not.toHaveBeenCalled();
		expect(result.structuredContent).toMatchObject({ violations: [] });
	});

	it('validates an update when id is given', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockResolvedValue({ data: { violations: [{ property: 'Founded', message: 'bad' }] } }),
		});
		const ctx = contextOn(mock);
		const result = await neowikiValidateSubject.handle({ id: 's1demo', statements: stmts }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as { url: string; data: string };
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo/validate');
		expect(JSON.parse(call.data)).toEqual({ statements: stmts });
		expect(result.structuredContent).toMatchObject({
			violations: [{ property: 'Founded', message: 'bad' }],
		});
	});

	it('rejects a new-subject validation with no schema', async () => {
		const ctx = contextOn(createMockMwn());
		const result = await neowikiValidateSubject.handle({ statements: stmts }, ctx);
		assertStructuredError(result, 'invalid_input');
	});
});
