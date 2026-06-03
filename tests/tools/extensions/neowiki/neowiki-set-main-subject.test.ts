import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiSetMainSubject } from '../../../../src/tools/extensions/neowiki/neowiki-set-main-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

describe('neowiki-set-main-subject', () => {
	it('promotes a subject and returns changed', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'changed' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 's1demo' }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as { url: string; method: string; data: string };
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/mainSubject');
		expect(call.method).toBe('PUT');
		expect(JSON.parse(call.data)).toEqual({ subjectId: 's1demo' });
		expect(result.structuredContent).toMatchObject({ pageId: 7, status: 'changed' });
	});

	it('sends subjectId:null to clear the main subject', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'changed' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiSetMainSubject.handle({ pageId: 7, subjectId: null }, ctx);
		expect(JSON.parse((mock.rawRequest.mock.calls[0][0] as { data: string }).data)).toEqual({
			subjectId: null,
		});
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiSetMainSubject.handle({ subjectId: 's1' }, ctx);
		assertStructuredError(result, 'invalid_input');
	});

	it('maps a 404 (subject not on page) to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(404, { status: 'error', message: 'Subject not found on this page' }),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 'sX' }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
