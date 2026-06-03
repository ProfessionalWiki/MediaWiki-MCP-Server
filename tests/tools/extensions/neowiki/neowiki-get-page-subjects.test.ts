import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiGetPageSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-get-page-subjects.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

const pageSubjectsBody = {
	data: {
		pageId: 65,
		mainSubjectId: 'sMain',
		subjects: {
			sMain: {
				id: 'sMain',
				label: 'Rijksmuseum',
				schema: 'Museum',
				statements: { Founded: { type: 'number', value: 1800 } },
			},
			sChild: { id: 'sChild', label: 'Rijksmuseum 2024', schema: 'Attendance', statements: {} },
		},
	},
};

describe('neowiki-get-page-subjects', () => {
	it('resolves a title to a pageId, then flattens subjects with isMain', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue({ query: { pages: [{ pageid: 65, title: 'Rijksmuseum' }] } }),
			rawRequest: vi.fn().mockResolvedValue(pageSubjectsBody),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetPageSubjects.handle({ title: 'Rijksmuseum' }, ctx);

		expect((mock.request.mock.calls[0][0] as Record<string, unknown>).titles).toBe('Rijksmuseum');
		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/page/65/subjects',
		);
		expect(result.structuredContent).toMatchObject({
			pageId: 65,
			mainSubjectId: 'sMain',
			subjects: [
				{ id: 'sMain', isMain: true, schema: 'Museum' },
				{ id: 'sChild', isMain: false, schema: 'Attendance' },
			],
		});
	});

	it('uses a numeric pageId directly without a title lookup', async () => {
		const mock = createMockMwn({
			request: vi.fn(),
			rawRequest: vi
				.fn()
				.mockResolvedValue({ data: { pageId: 65, mainSubjectId: null, subjects: {} } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetPageSubjects.handle({ pageId: 65 }, ctx);
		expect(mock.request).not.toHaveBeenCalled();
		expect(result.structuredContent).toMatchObject({ subjects: [] });
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiGetPageSubjects.handle({}, ctx);
		assertStructuredError(result, 'invalid_input');
	});

	it('rejects when both title and pageId are given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiGetPageSubjects.handle({ title: 'X', pageId: 1 }, ctx);
		assertStructuredError(result, 'invalid_input');
	});

	it('returns not_found for a missing title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ title: 'Nope', missing: true }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetPageSubjects.handle({ title: 'Nope' }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
