import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiValidateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-validate-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

const stmts = { Founded: { propertyType: 'number', value: 2019 } };

describe('neowiki-validate-subject', () => {
	it('validates a new subject against a schema (no CSRF token)', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { violations: [] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiValidateSubject.handle(
			{ schema: 'Company', label: 'ACME', statements: stmts },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/validate');
		expect(JSON.parse(call.data)).toEqual({ schema: 'Company', label: 'ACME', statements: stmts });
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
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiValidateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as { url: string; data: string };
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo/validate');
		expect(JSON.parse(call.data)).toEqual({ label: 'ACME', statements: stmts });
		expect(result.structuredContent).toMatchObject({
			violations: [{ property: 'Founded', message: 'bad' }],
		});
	});

	it('rejects a new-subject validation with no schema', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiValidateSubject.handle({ label: 'ACME', statements: stmts }, ctx);
		assertStructuredError(result, 'invalid_input');
	});
});
