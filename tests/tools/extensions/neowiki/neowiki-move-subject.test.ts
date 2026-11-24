import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { neowikiMoveSubject } from '../../../../src/tools/extensions/neowiki/neowiki-move-subject.ts';

const move = { id: 's1demo', pageId: 7 };

const changed = { status: 'changed' };

describe('neowiki-move-subject', () => {
	it('POSTs the move to the target page with a CSRF token', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiMoveSubject.handle(move, ctx);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo/move');
		expect(request.method).toBe('POST');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(request.body).toMatchObject({ targetPageId: 7 });
	});

	it('resolves a target title to its page ID', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ pageid: 9, title: 'Berlin' }] } }),
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: changed }),
		});

		await neowikiMoveSubject.handle({ id: 's1demo', title: 'Berlin' }, contextOn(mock));

		expect(sentRequest(mock).body).toMatchObject({ targetPageId: 9 });
	});

	it("makes the subject the target page's Main Subject when isMain is true", async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiMoveSubject.handle({ ...move, isMain: true }, ctx);

		expect(sentRequest(mock).body).toMatchObject({ makeMainSubject: true });
	});

	it("leaves the target page's Main Subject as it is by default", async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiMoveSubject.handle(move, ctx);

		expect(sentRequest(mock).body.makeMainSubject ?? false).toBe(false);
	});

	it('returns whether the subject moved and the page it is on', async () => {
		const { ctx } = writeContextReturning({ status: 'unchanged' });

		const result = await neowikiMoveSubject.handle(move, ctx);

		expect(result.structuredContent).toEqual({
			subjectId: 's1demo',
			status: 'unchanged',
			pageId: 7,
		});
	});

	it('refuses a call that names both a title and a page ID', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		const result = await neowikiMoveSubject.handle({ ...move, title: 'Berlin' }, ctx);

		assertStructuredError(result, 'invalid_input');
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('returns not_found for a target title that does not exist', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
		});

		const result = await neowikiMoveSubject.handle(
			{ id: 's1demo', title: 'Nope' },
			contextOn(mock),
		);

		assertStructuredError(result, 'not_found');
	});

	it('attributes the move to the tool that made it', async () => {
		const { mock, ctx } = writeContextReturning(changed);

		await neowikiMoveSubject.handle({ ...move, comment: 'belongs with Berlin' }, ctx);

		expect(sentRequest(mock).body).toMatchObject({
			comment: 'belongs with Berlin (via neowiki-move-subject on MediaWiki MCP Server)',
		});
	});
});
