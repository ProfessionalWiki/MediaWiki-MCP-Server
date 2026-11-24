import { describe, it, expect } from 'vitest';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiSetStatement } from '../../../../src/tools/extensions/neowiki/neowiki-set-statement.ts';

const statement = { id: 's1demo', baseRevisionId: 1234, property: 'Founded at', value: 2019 };

const updated = { status: 'updated', subjectId: 's1demo' };

describe('neowiki-set-statement', () => {
	it("PUTs the value to the statement's own path with a CSRF token", async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiSetStatement.handle(statement, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe(
			'https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo/statements/Founded%20at',
		);
		expect(request.method).toBe('PUT');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(request.body).toMatchObject({ statement: { value: 2019 } });
	});

	it('sends the revision the change was made from', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiSetStatement.handle(statement, ctx);

		expect(sentRequest(mock).body).toMatchObject({ baseRevisionId: 1234 });
	});

	it("leaves the property's type to the schema when none is given", async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiSetStatement.handle(statement, ctx);

		expect(sentRequest(mock).body.statement).not.toHaveProperty('propertyType');
	});

	it('sends the property type it is given', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiSetStatement.handle({ ...statement, propertyType: 'number' }, ctx);

		expect(sentRequest(mock).body).toMatchObject({
			statement: { propertyType: 'number', value: 2019 },
		});
	});

	it('returns the revision the page is at after the write, with the subject as saved', async () => {
		const { ctx } = writeContextReturning({
			...updated,
			revisionId: 1235,
			violations: [],
			subject: {
				id: 's1demo',
				schema: 'Company',
				statements: { 'Founded at': { propertyType: 'number', value: 2019 } },
			},
		});

		const result = await neowikiSetStatement.handle(statement, ctx);

		expect(result.structuredContent).toMatchObject({
			subjectId: 's1demo',
			revisionId: 1235,
			subject: { statements: { 'Founded at': { propertyType: 'number', value: 2019 } } },
		});
	});

	it('attributes the write to the tool that made it', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiSetStatement.handle({ ...statement, comment: 'fix year' }, ctx);

		expect(sentRequest(mock).body).toMatchObject({
			comment: 'fix year (via neowiki-set-statement on MediaWiki MCP Server)',
		});
	});
});
