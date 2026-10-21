import { describe, it, expect } from 'vitest';
import { contextReturning, requestedUrl } from '../../../helpers/rawRequest.ts';
import { neowikiListSchemas } from '../../../../src/tools/extensions/neowiki/neowiki-list-schemas.ts';
import { assertStructuredSuccess } from '../../../helpers/structuredResult.ts';

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
