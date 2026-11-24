import { describe, it, expect } from 'vitest';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiRemoveStatement } from '../../../../src/tools/extensions/neowiki/neowiki-remove-statement.ts';

const statement = { id: 's1demo', baseRevisionId: 1234, property: 'Founded at' };

const updated = { status: 'updated', subjectId: 's1demo' };

describe('neowiki-remove-statement', () => {
	it("DELETEs the statement's own path with a CSRF token", async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiRemoveStatement.handle(statement, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe(
			'https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo/statements/Founded%20at',
		);
		expect(request.method).toBe('DELETE');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
	});

	it('sends the revision the change was made from', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiRemoveStatement.handle(statement, ctx);

		expect(sentRequest(mock).body).toMatchObject({ baseRevisionId: 1234 });
	});

	it('returns the revision the page is at after the write', async () => {
		const { ctx } = writeContextReturning({ ...updated, revisionId: 1235 });

		const result = await neowikiRemoveStatement.handle(statement, ctx);

		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', revisionId: 1235 });
	});

	it('attributes the write to the tool that made it', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiRemoveStatement.handle({ ...statement, comment: 'obsolete' }, ctx);

		expect(sentRequest(mock).body).toMatchObject({
			comment: 'obsolete (via neowiki-remove-statement on MediaWiki MCP Server)',
		});
	});
});
