import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiCreateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-create-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

const stmts = { Country: { propertyType: 'text', value: ['Germany'] } };

describe('neowiki-create-subject', () => {
	it('resolves a title and posts a child subject with a CSRF token', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ pageid: 7, title: 'Berlin' }] } }),
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'created', subjectId: 's1demo' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCreateSubject.handle(
			{ title: 'Berlin', label: 'Berlin', schema: 'City', statements: stmts },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/childSubjects');
		expect(call.method).toBe('POST');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(JSON.parse(call.data)).toMatchObject({
			label: 'Berlin',
			schema: 'City',
			statements: stmts,
		});
		expect(result.structuredContent).toMatchObject({
			subjectId: 's1demo',
			status: 'created',
			pageId: 7,
		});
	});

	it('posts to /mainSubject when isMain is true', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'created', subjectId: 's1' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiCreateSubject.handle(
			{ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/page/7/mainSubject',
		);
	});

	it('surfaces a 201 error body as a conflict', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockResolvedValue({ data: { status: 'error', message: 'Subject already exists' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCreateSubject.handle(
			{ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		assertStructuredError(result, 'conflict');
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiCreateSubject.handle(
			{ label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		assertStructuredError(result, 'invalid_input');
	});

	it('returns not_found for an unknown title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCreateSubject.handle(
			{ title: 'Nope', label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		assertStructuredError(result, 'not_found');
	});
});
