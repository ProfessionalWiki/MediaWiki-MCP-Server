import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { neowikiSearchSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-search-subjects.ts';

describe('neowiki-search-subjects', () => {
	it('passes schema and search and returns matches', async () => {
		const mock = createMockMwn({
			rawRequest: vi
				.fn()
				.mockResolvedValue({ data: [{ id: 's1demo1aaaaaaa1', label: 'ACME Inc' }] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSearchSubjects.handle({ schema: 'Company', search: 'a' }, ctx);

		const url = (mock.rawRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain('/subject-labels?');
		expect(url).toContain('schema=Company');
		expect(url).toContain('search=a');
		expect(result.structuredContent).toMatchObject({
			subjects: [{ id: 's1demo1aaaaaaa1', label: 'ACME Inc' }],
		});
	});

	it('searches every schema when none is given, up to the endpoint limit', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: [] }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		const url = new URL((mock.rawRequest.mock.calls[0][0] as { url: string }).url);
		expect(url.searchParams.has('schema')).toBe(false);
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('marks a result that fills the limit as capped', async () => {
		const matches = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, label: `A${i}` }));
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: matches }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'capped-no-continuation', returnedCount: 50, limit: 50 },
		});
	});

	it('returns an empty list when the response is not an array', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSearchSubjects.handle({ schema: 'Company', search: 'zzz' }, ctx);
		expect(result.structuredContent).toMatchObject({ subjects: [] });
	});
});
