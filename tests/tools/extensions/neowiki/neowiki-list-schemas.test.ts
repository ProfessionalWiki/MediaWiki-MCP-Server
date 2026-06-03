import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { neowikiListSchemas } from '../../../../src/tools/extensions/neowiki/neowiki-list-schemas.js';
import { assertStructuredSuccess } from '../../../helpers/structuredResult.js';

describe('neowiki-list-schemas', () => {
	it('requests /schemas and returns the schema summaries', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: {
					schemas: [{ name: 'Company', description: '', propertyCount: 10 }],
					totalRows: 1,
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiListSchemas.handle({}, ctx);

		const url = (mock.rawRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain('/rest.php/neowiki/v0/schemas?');
		expect(url).toContain('limit=50');
		expect(url).toContain('offset=0');
		expect(assertStructuredSuccess(result)).toContain('Company');
		expect(result.structuredContent).toMatchObject({
			schemas: [{ name: 'Company', propertyCount: 10 }],
		});
		expect(result.structuredContent).not.toHaveProperty('truncation');
	});

	it('emits a more-available truncation when totalRows exceeds the returned page', async () => {
		const mock = createMockMwn({
			rawRequest: vi.fn().mockResolvedValue({
				data: { schemas: [{ name: 'A', description: '', propertyCount: 1 }], totalRows: 17 },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiListSchemas.handle({}, ctx);
		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'more-available', continueWith: { param: 'continueFrom', value: '1' } },
		});
	});

	it('rejects a non-integer continueFrom', async () => {
		const mock = createMockMwn({ rawRequest: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiListSchemas.handle({ continueFrom: 'abc' }, ctx);
		expect(result.isError).toBe(true);
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});
});
