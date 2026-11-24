import { describe, it, expect } from 'vitest';
import { writeContextReturningInTurn, sentRequests } from '../../../helpers/rawRequest.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { neowikiCreateSchema } from '../../../../src/tools/extensions/neowiki/neowiki-create-schema.ts';

const absent = { schema: null };

const saved = {
	schema: { description: 'A company', propertyDefinitions: { Website: { type: 'url' } } },
};

const company = {
	name: 'Company',
	description: 'A company',
	propertyDefinitions: { Website: { type: 'url' } },
};

describe('neowiki-create-schema', () => {
	it('PUTs the schema to its own path with a CSRF token', async () => {
		const { mock, ctx } = writeContextReturningInTurn(absent, saved);

		await neowikiCreateSchema.handle(company, ctx);

		const write = sentRequests(mock)[1];
		expect(write.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/schema/Company');
		expect(write.method).toBe('PUT');
		expect(write.headers['X-CSRF-TOKEN']).toBe('tok');
	});

	it('sends the schema it is given', async () => {
		const { mock, ctx } = writeContextReturningInTurn(absent, saved);

		await neowikiCreateSchema.handle(
			{ ...company, labels: { de: 'Unternehmen' }, subjectsAreControlled: true },
			ctx,
		);

		expect(sentRequests(mock)[1].body).toMatchObject({
			schema: {
				description: 'A company',
				labels: { de: 'Unternehmen' },
				subjectsAreControlled: true,
				propertyDefinitions: { Website: { type: 'url' } },
			},
		});
	});

	it('refuses a schema that already exists, writing nothing', async () => {
		const { mock, ctx } = writeContextReturningInTurn(saved);

		const result = await neowikiCreateSchema.handle(company, ctx);

		assertStructuredError(result, 'conflict');
		expect(sentRequests(mock)).toHaveLength(1);
	});

	it('returns the schema as saved, in the shape neowiki-get-schema returns', async () => {
		const { ctx } = writeContextReturningInTurn(absent, saved);

		const result = await neowikiCreateSchema.handle(company, ctx);

		expect(result.structuredContent).toEqual({ status: 'created', ...company });
	});

	it('attributes the write to the tool that made it', async () => {
		const { mock, ctx } = writeContextReturningInTurn(absent, saved);

		await neowikiCreateSchema.handle({ ...company, comment: 'model companies' }, ctx);

		expect(sentRequests(mock)[1].body).toMatchObject({
			comment: 'model companies (via neowiki-create-schema on MediaWiki MCP Server)',
		});
	});
});
