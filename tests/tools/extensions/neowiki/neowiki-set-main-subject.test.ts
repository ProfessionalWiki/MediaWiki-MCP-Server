import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiSetMainSubject } from '../../../../src/tools/extensions/neowiki/neowiki-set-main-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { httpError } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const changed = { status: 'changed' };

describe('neowiki-set-main-subject', () => {
	it('promotes a subject and returns changed', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		const result = await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 's1demo' }, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/mainSubject');
		expect(request.method).toBe('PUT');
		expect(request.body).toMatchObject({ subjectId: 's1demo' });
		expect(result.structuredContent).toMatchObject({ pageId: 7, status: 'changed' });
	});

	it('sends subjectId:null to clear the main subject', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiSetMainSubject.handle({ pageId: 7, subjectId: null }, ctx);

		expect(sentRequest(mock).body).toMatchObject({ subjectId: null });
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiSetMainSubject.handle(
			{ pageId: 7, subjectId: 's1demo', comment: 'promote Berlin' },
			ctx,
		);

		expect(sentRequest(mock).body).toEqual({
			subjectId: 's1demo',
			comment: 'promote Berlin (via neowiki-set-main-subject on MediaWiki MCP Server)',
		});
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = contextOn(createMockMwn());
		const result = await dispatch(neowikiSetMainSubject, ctx)({ subjectId: 's1' });
		assertStructuredError(result, 'invalid_input');
	});

	it('maps a 404 (subject not on page) to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(404, { status: 'error', message: 'Subject not found on this page' }),
				),
		});
		const ctx = contextOn(mock);
		const result = await dispatch(neowikiSetMainSubject, ctx)({ pageId: 7, subjectId: 'sX' });
		assertStructuredError(result, 'not_found');
	});
});
