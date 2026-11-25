import { describe, it, expect } from 'vitest';
import { contextReturning } from '../../../helpers/rawRequest.ts';
import { neowikiGetSchema } from '../../../../src/tools/extensions/neowiki/neowiki-get-schema.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

describe('neowiki-get-schema', () => {
	it('returns the property definitions keyed by property name, as NeoWiki stores them', async () => {
		const { mock, ctx } = contextReturning({
			schema: {
				description: 'A company.',
				propertyDefinitions: {
					'Main product': {
						type: 'relation',
						targetSchemas: ['Product'],
						multiple: false,
					},
					Status: { type: 'select', required: true, options: [{ id: 'o1', label: 'Active' }] },
				},
			},
		});
		const result = await neowikiGetSchema.handle({ name: 'Company' }, ctx);

		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain('/schema/Company');
		expect(result.structuredContent).toMatchObject({
			name: 'Company',
			description: 'A company.',
			propertyDefinitions: {
				'Main product': { type: 'relation', targetSchemas: ['Product'], multiple: false },
				Status: { type: 'select', required: true, options: [{ id: 'o1', label: 'Active' }] },
			},
		});
	});

	it('says when the schema describes Dependent Subjects', async () => {
		const { ctx } = contextReturning({
			schema: { subjectsAreDependent: true, propertyDefinitions: {} },
		});
		const result = await neowikiGetSchema.handle({ name: 'Birth' }, ctx);

		expect(result.structuredContent).toMatchObject({ subjectsAreDependent: true });
	});

	it('says when the schema describes Controlled Subjects', async () => {
		const { ctx } = contextReturning({
			schema: { subjectsAreControlled: true, propertyDefinitions: {} },
		});
		const result = await neowikiGetSchema.handle({ name: 'Material' }, ctx);

		expect(result.structuredContent).toMatchObject({ subjectsAreControlled: true });
	});

	it('leaves out the flags of a schema that sets neither', async () => {
		const { ctx } = contextReturning({ schema: { propertyDefinitions: {} } });
		const result = await neowikiGetSchema.handle({ name: 'Person' }, ctx);

		expect(result.structuredContent).not.toHaveProperty('subjectsAreDependent');
		expect(result.structuredContent).not.toHaveProperty('subjectsAreControlled');
	});

	it('returns what the UI calls the schema in each language', async () => {
		const { ctx } = contextReturning({
			schema: { labels: { de: 'Unternehmen' }, propertyDefinitions: {} },
		});
		const result = await neowikiGetSchema.handle({ name: 'Company' }, ctx);

		expect(result.structuredContent).toMatchObject({ labels: { de: 'Unternehmen' } });
	});

	it('returns not_found when the response has no schema', async () => {
		const { ctx } = contextReturning({});
		const result = await neowikiGetSchema.handle({ name: 'Nope' }, ctx);
		assertStructuredError(result, 'not_found');
	});

	it('URL-encodes the schema name', async () => {
		const { mock, ctx } = contextReturning({ schema: {} });
		await neowikiGetSchema.handle({ name: 'Schema Name' }, ctx);
		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/schema/Schema%20Name',
		);
	});
});
