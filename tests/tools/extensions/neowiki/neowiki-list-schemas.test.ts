import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import type { ToolContext } from '../../../../src/runtime/context.ts';
import { neowikiListSchemas } from '../../../../src/tools/extensions/neowiki/neowiki-list-schemas.ts';
import { assertStructuredSuccess } from '../../../helpers/structuredResult.ts';

function contextReturning(data: unknown): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data }) });
	return { mock, ctx: fakeContext({ mwn: async () => mock as never }) };
}

function requestedUrl(mock: MockMwn): URL {
	return new URL((mock.rawRequest.mock.calls[0][0] as { url: string }).url);
}

describe('neowiki-list-schemas', () => {
	it('requests the first page of /schemas and returns the schema summaries', async () => {
		const { mock, ctx } = contextReturning({
			schemas: [{ name: 'Company', description: '', propertyCount: 10 }],
			nextCursor: null,
		});
		const result = await neowikiListSchemas.handle({}, ctx);

		const url = requestedUrl(mock);
		expect(url.pathname).toBe('/w/rest.php/neowiki/v0/schemas');
		expect(url.searchParams.get('limit')).toBe('50');
		expect(url.searchParams.has('cursor')).toBe(false);
		expect(assertStructuredSuccess(result)).toContain('Company');
		expect(result.structuredContent).toMatchObject({
			schemas: [{ name: 'Company', propertyCount: 10 }],
		});
		expect(result.structuredContent).not.toHaveProperty('truncation');
	});

	it('flags only the schemas whose subjects are dependent', async () => {
		const { ctx } = contextReturning({
			schemas: [
				{ name: 'Person', description: '', propertyCount: 3, subjectsAreDependent: false },
				{ name: 'Birth', description: '', propertyCount: 2, subjectsAreDependent: true },
			],
			nextCursor: null,
		});
		const result = await neowikiListSchemas.handle({}, ctx);

		expect(result.structuredContent).toEqual({
			schemas: [
				{ name: 'Person', description: '', propertyCount: 3 },
				{ name: 'Birth', description: '', propertyCount: 2, subjectsAreDependent: true },
			],
		});
	});

	it('hands back the next cursor as continueFrom while more schemas remain', async () => {
		const { ctx } = contextReturning({
			schemas: [{ name: 'A', description: '', propertyCount: 1 }],
			nextCursor: '1462',
		});
		const result = await neowikiListSchemas.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({
			truncation: {
				reason: 'more-available',
				continueWith: { param: 'continueFrom', value: '1462' },
			},
		});
	});

	it('passes continueFrom back as the cursor', async () => {
		const { mock, ctx } = contextReturning({ schemas: [], nextCursor: null });
		await neowikiListSchemas.handle({ continueFrom: '1462' }, ctx);

		expect(requestedUrl(mock).searchParams.get('cursor')).toBe('1462');
	});
});
