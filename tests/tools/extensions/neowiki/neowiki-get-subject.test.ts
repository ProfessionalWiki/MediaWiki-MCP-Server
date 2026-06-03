import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiGetSubject } from '../../../../src/tools/extensions/neowiki/neowiki-get-subject.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

describe('neowiki-get-subject', () => {
	it('unwraps the subject envelope and flattens statements', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: {
					requestedId: 's1demo1aaaaaaa1',
					subjects: {
						s1demo1aaaaaaa1: {
							id: 's1demo1aaaaaaa1',
							label: 'ACME Inc',
							schema: 'Company',
							statements: { Status: { type: 'select', value: ['o1demo1aaaaaaa1'] } },
						},
					},
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSubject.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/subject/s1demo1aaaaaaa1',
		);
		expect(result.structuredContent).toMatchObject({
			id: 's1demo1aaaaaaa1',
			label: 'ACME Inc',
			schema: 'Company',
			statements: [{ property: 'Status', type: 'select', value: ['o1demo1aaaaaaa1'] }],
		});
	});

	it('returns not_found when the subject is absent', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({ data: { requestedId: 'sX', subjects: {} } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSubject.handle({ id: 'sX' }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
