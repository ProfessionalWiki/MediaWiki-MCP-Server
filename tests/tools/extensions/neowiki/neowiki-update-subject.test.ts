import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiUpdateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-update-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

const stmts = { Founded: { propertyType: 'number', value: 2019 } };

describe('neowiki-update-subject', () => {
	it('PUTs a full replace with a CSRF token', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'updated', subjectId: 's1demo' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiUpdateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts, comment: 'tidy' },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(call.method).toBe('PUT');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(JSON.parse(call.data)).toEqual({ label: 'ACME', statements: stmts, comment: 'tidy' });
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'updated' });
	});

	it('maps a 404 to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(404, { status: 'error', message: 'gone' })),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiUpdateSubject.handle({ id: 'sX', label: 'X', statements: {} }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
