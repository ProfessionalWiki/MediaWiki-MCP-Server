import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { requestedUrl } from '../../../helpers/rawRequest.ts';
import { neowikiGetSubject } from '../../../../src/tools/extensions/neowiki/neowiki-get-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

function mockReturningSubject(fields: Record<string, unknown>): MockMwn {
	return createMockMwn({
		rawRequest: vi.fn().mockResolvedValue({
			data: {
				requestedId: 's1demo1aaaaaaa1',
				subjects: {
					s1demo1aaaaaaa1: { id: 's1demo1aaaaaaa1', schema: 'Company', statements: {}, ...fields },
				},
			},
		}),
	});
}

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
							statements: { Status: { propertyType: 'select', value: ['o1demo1aaaaaaa1'] } },
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

	it('asks for the page fields and returns where the subject lives', async () => {
		const mock = mockReturningSubject({ pageId: 42, pageTitle: 'ACME Inc', pageNamespaceId: 0 });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSubject.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect(requestedUrl(mock).searchParams.get('expand')).toBe('page');
		expect(result.structuredContent).toMatchObject({ pageId: 42, pageTitle: 'ACME Inc' });
	});

	it('shows a subject without a label under its display name', async () => {
		const mock = mockReturningSubject({ label: null, displayName: 'ACME Inc' });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSubject.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect(result.structuredContent).toMatchObject({ label: '', displayName: 'ACME Inc' });
	});

	it('names the Host Subject of a Dependent Subject', async () => {
		const hostSubject = {
			id: 's1demo5sssssss1',
			displayName: 'Pablo Picasso',
			displayNameIsGenerated: false,
			schema: 'Person',
		};
		const mock = mockReturningSubject({ label: null, displayName: 'Birth', hostSubject });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSubject.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect(result.structuredContent).toMatchObject({ hostSubject });
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
