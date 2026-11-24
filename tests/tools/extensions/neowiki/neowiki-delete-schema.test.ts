import { describe, it, expect } from 'vitest';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiDeleteSchema } from '../../../../src/tools/extensions/neowiki/neowiki-delete-schema.ts';

describe('neowiki-delete-schema', () => {
	it('DELETEs the schema with a CSRF token', async () => {
		const { mock, ctx } = writeContextReturning('');

		await neowikiDeleteSchema.handle({ name: 'Company' }, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/schema/Company');
		expect(request.method).toBe('DELETE');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
	});

	it('returns the name of the schema it deleted', async () => {
		const { ctx } = writeContextReturning('');

		const result = await neowikiDeleteSchema.handle({ name: 'Company' }, ctx);

		expect(result.structuredContent).toEqual({ name: 'Company', status: 'deleted' });
	});

	it('gives the deletion the reason the caller states, attributed to the tool', async () => {
		const { mock, ctx } = writeContextReturning('');

		await neowikiDeleteSchema.handle({ name: 'Company', comment: 'merged into Organization' }, ctx);

		expect(sentRequest(mock).body).toMatchObject({
			comment: 'merged into Organization (via neowiki-delete-schema on MediaWiki MCP Server)',
		});
	});
});
