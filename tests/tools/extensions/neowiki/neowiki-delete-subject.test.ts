import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiDeleteSubject } from '../../../../src/tools/extensions/neowiki/neowiki-delete-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

describe('neowiki-delete-subject', () => {
	it('DELETEs with a CSRF token and reports deleted', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: '' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiDeleteSubject.handle({ id: 's1demo', comment: 'spam' }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(call.method).toBe('DELETE');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(JSON.parse(call.data)).toEqual({ comment: 'spam' });
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'deleted' });
	});

	it('omits the body when no comment is given', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: '' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiDeleteSubject.handle({ id: 's1demo' }, ctx);
		expect((mock.rawRequest.mock.calls[0][0] as { data?: unknown }).data).toBeUndefined();
	});

	it('maps a 403 to permission_denied', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(403, { status: 'error', message: 'nope' })),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiDeleteSubject.handle({ id: 's1demo' }, ctx);
		assertStructuredError(result, 'permission_denied');
	});
});
