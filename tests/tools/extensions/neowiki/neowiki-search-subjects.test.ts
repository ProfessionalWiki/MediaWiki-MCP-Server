import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiSearchSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-search-subjects.js';

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

	it('returns an empty list when the response is not an array', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSearchSubjects.handle({ schema: 'Company', search: 'zzz' }, ctx);
		expect(result.structuredContent).toMatchObject({ subjects: [] });
	});
});
