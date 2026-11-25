import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { withoutEditAttribution, contextOn } from '../../../helpers/fakeContext.ts';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiDeleteSubject } from '../../../../src/tools/extensions/neowiki/neowiki-delete-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { httpError } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

describe('neowiki-delete-subject', () => {
	it('DELETEs with a CSRF token and reports deleted', async () => {
		const { mock, ctx } = writeContextReturning('');

		const result = await neowikiDeleteSubject.handle({ id: 's1demo', comment: 'spam' }, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(request.method).toBe('DELETE');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'deleted' });
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = writeContextReturning('');

		await neowikiDeleteSubject.handle({ id: 's1demo', comment: 'spam' }, ctx);

		expect(sentRequest(mock).body).toEqual({
			comment: 'spam (via neowiki-delete-subject on MediaWiki MCP Server)',
		});
	});

	it('omits the body when a wiki opts out and the caller gave no comment', async () => {
		const { mock, ctx } = writeContextReturning('');

		await neowikiDeleteSubject.handle({ id: 's1demo' }, withoutEditAttribution(ctx));

		expect(sentRequest(mock).data).toBeUndefined();
	});

	it('reports a 403 as a permission_denied failure of the delete', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(403, { status: 'error', message: 'nope' })),
		});
		const ctx = contextOn(mock);

		const result = await dispatch(neowikiDeleteSubject, ctx)({ id: 's1demo' });

		expect(assertStructuredError(result, 'permission_denied').message).toBe(
			'Failed to delete NeoWiki subject: nope',
		);
	});
});
