import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiGetSchema } from '../../../../src/tools/extensions/neowiki/neowiki-get-schema.js';
import { assertStructuredError } from '../../../helpers/structuredResult.js';

describe('neowiki-get-schema', () => {
	it('normalizes propertyDefinitions to a properties array, preserving relation/select metadata', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: {
					schema: {
						description: 'A company.',
						propertyDefinitions: {
							'Main product': {
								type: 'relation',
								relation: 'Has main product',
								targetSchema: 'Product',
								multiple: false,
							},
							Status: { type: 'select', required: true, options: [{ id: 'o1', label: 'Active' }] },
						},
					},
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSchema.handle({ name: 'Company' }, ctx);

		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain('/schema/Company');
		expect(result.structuredContent).toMatchObject({
			name: 'Company',
			description: 'A company.',
			properties: [
				{
					name: 'Main product',
					type: 'relation',
					relation: 'Has main product',
					targetSchema: 'Product',
				},
				{ name: 'Status', type: 'select', options: [{ id: 'o1', label: 'Active' }] },
			],
		});
	});

	it('returns not_found when the response has no schema', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: {} }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiGetSchema.handle({ name: 'Nope' }, ctx);
		assertStructuredError(result, 'not_found');
	});

	it('URL-encodes the schema name', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data: { schema: {} } }) });
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiGetSchema.handle({ name: 'Schema Name' }, ctx);
		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/schema/Schema%20Name',
		);
	});
});
