import { describe, it, expect } from 'vitest';
import { writeContextReturningInTurn, sentRequests } from '../../../helpers/rawRequest.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { neowikiUpdateSchema } from '../../../../src/tools/extensions/neowiki/neowiki-update-schema.ts';

const current = {
	schema: { description: 'A company', propertyDefinitions: { Website: { type: 'url' } } },
};

const saved = {
	schema: {
		description: 'A company',
		propertyDefinitions: { Website: { type: 'url' }, Founded: { type: 'number' } },
	},
};

const company = {
	name: 'Company',
	description: 'A company',
	properties: [
		{ name: 'Website', type: 'url' },
		{ name: 'Founded', type: 'number' },
	],
};

describe('neowiki-update-schema', () => {
	it('PUTs the whole schema to its own path with a CSRF token', async () => {
		const { mock, ctx } = writeContextReturningInTurn(current, saved);

		await neowikiUpdateSchema.handle(company, ctx);

		const write = sentRequests(mock)[1];
		expect(write.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/schema/Company');
		expect(write.method).toBe('PUT');
		expect(write.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(write.body).toMatchObject({
			schema: {
				description: 'A company',
				propertyDefinitions: { Website: { type: 'url' }, Founded: { type: 'number' } },
			},
		});
	});

	it('refuses a schema that does not exist, writing nothing', async () => {
		const { mock, ctx } = writeContextReturningInTurn({ schema: null });

		const result = await neowikiUpdateSchema.handle(company, ctx);

		assertStructuredError(result, 'not_found');
		expect(sentRequests(mock)).toHaveLength(1);
	});

	it('returns the schema as saved, in the shape neowiki-get-schema returns', async () => {
		const { ctx } = writeContextReturningInTurn(current, saved);

		const result = await neowikiUpdateSchema.handle(company, ctx);

		expect(result.structuredContent).toEqual({ status: 'updated', ...company });
	});

	it('attributes the write to the tool that made it', async () => {
		const { mock, ctx } = writeContextReturningInTurn(current, saved);

		await neowikiUpdateSchema.handle({ ...company, comment: 'add founding year' }, ctx);

		expect(sentRequests(mock)[1].body).toMatchObject({
			comment: 'add founding year (via neowiki-update-schema on MediaWiki MCP Server)',
		});
	});
});
