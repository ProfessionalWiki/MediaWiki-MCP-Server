import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { updatePage } from '../../src/tools/update-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

function successResponse(overrides: Record<string, unknown> = {}) {
	return {
		edit: {
			result: 'Success',
			pageid: 5,
			title: 'My Page',
			contentmodel: 'wikitext',
			oldrevid: 41,
			newrevid: 42,
			newtimestamp: '2026-01-02T00:00:00Z',
			...overrides,
		},
	};
}

function fakeEdit(response: unknown = successResponse()) {
	const request = vi.fn().mockResolvedValue(response);
	const mock = createMockMwn({
		request,
		getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
	});
	const submit = vi
		.fn()
		.mockImplementation(async (_m: never, params: Record<string, unknown>) =>
			mock.request({ ...params, token: 'csrf-token', formatversion: '2' }),
		);
	const ctx = fakeContext({
		mwn: async () => mock as never,
		edit: {
			submit: submit as never,
			submitUpload: vi.fn() as never,
			applyTags: (o: object) => ({ ...o }),
		},
	});
	return { mock, request, submit, ctx };
}

describe('update-page', () => {
	describe('full-page replacement', () => {
		it('sends text=source with nocreate and baserevid for conflict detection', async () => {
			const { request, submit, ctx } = fakeEdit();

			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'Updated content',
					latestId: 41,
					comment: 'edit summary',
				},
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('Page ID: 5');
			expect(text).toContain('Title: My Page');
			expect(text).toContain('Latest revision ID: 42');
			expect(text).toContain('Latest revision timestamp: 2026-01-02T00:00:00Z');
			expect(text).toContain('Content model: wikitext');

			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({
				action: 'edit',
				title: 'My Page',
				text: 'Updated content',
				nocreate: true,
				baserevid: 41,
			});
			expect(params.summary).toContain('edit summary');
			// submit() is responsible for adding token and formatversion;
			// the handler must not add them itself.
			expect(params).not.toHaveProperty('token');
			expect(params).not.toHaveProperty('formatversion');

			// Sanity check: submit forwarded to mwn.request with token + formatversion.
			const requestParams = request.mock.calls[0][0];
			expect(requestParams).toMatchObject({
				token: 'csrf-token',
				formatversion: '2',
			});
		});

		it('omits baserevid when latestId is not supplied', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'content',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).not.toHaveProperty('baserevid');
		});

		it('returns error when the API response lacks a Success result', async () => {
			const { ctx } = fakeEdit({
				edit: { result: 'Failure', code: 'abusefilter-disallowed' },
			});

			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'content',
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('Failed to update page');
		});

		it('dispatches generic upstream failures with the standard verb prefix', async () => {
			const mock = createMockMwn({
				getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
			});
			const ctx = fakeContext({
				mwn: async () => mock as never,
				edit: {
					submit: vi.fn().mockRejectedValue(new Error('Edit conflict')) as never,
					submitUpload: vi.fn() as never,
					applyTags: (o: object) => ({ ...o }),
				},
			});

			const result = await dispatch(
				updatePage,
				ctx,
			)({
				title: 'My Page',
				source: 'content',
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toMatch(/Failed to update page: Edit conflict/);
		});

		it('surfaces the missingtitle error from mwn when page does not exist', async () => {
			const ctx = fakeContext({
				mwn: async () => createMockMwn() as never,
				edit: {
					submit: vi
						.fn()
						.mockRejectedValue(new Error("The page you specified doesn't exist.")) as never,
					submitUpload: vi.fn() as never,
					applyTags: (o: object) => ({ ...o }),
				},
			});

			const result = await dispatch(
				updatePage,
				ctx,
			)({
				title: 'Does Not Exist',
				source: 'content',
				latestId: 1,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain("doesn't exist");
		});
	});

	describe('tags', () => {
		it('submit injects tags through ctx.edit (handler does not add tags directly)', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'Tagged',
					source: 'content',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).not.toHaveProperty('tags');
		});
	});

	describe('section editing', () => {
		it("forwards section=2 as section='2' with text=source", async () => {
			const { submit, ctx } = fakeEdit();

			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'new section body',
					section: 2,
				},
				ctx,
			);

			expect(result.isError).toBeFalsy();
			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({ section: '2', text: 'new section body' });
		});

		it("forwards section=0 (lead) as section='0'", async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'lead',
					section: 0,
				},
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ section: '0' });
		});

		it('maps nosuchsection error to a friendly message via dispatcher', async () => {
			const ctx = fakeContext({
				mwn: async () => createMockMwn() as never,
				edit: {
					submit: vi
						.fn()
						.mockRejectedValue(new Error('nosuchsection: There is no section 99.')) as never,
					submitUpload: vi.fn() as never,
					applyTags: (o: object) => ({ ...o }),
				},
			});

			const result = await dispatch(
				updatePage,
				ctx,
			)({
				title: 'My Page',
				source: 'x',
				section: 99,
			});

			const envelope = assertStructuredError(result, 'not_found');
			expect(envelope.message).toBe('Section 99 does not exist');
		});

		it("forwards section='new' with sectionTitle as sectiontitle", async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'body',
					section: 'new',
					sectionTitle: 'History',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({
				section: 'new',
				sectiontitle: 'History',
				text: 'body',
			});
		});

		it("rejects section='new' without sectionTitle", async () => {
			const { ctx } = fakeEdit();
			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'body',
					section: 'new',
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain("sectionTitle is required when section='new'");
		});

		it('rejects sectionTitle when section is a number', async () => {
			const { ctx } = fakeEdit();
			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'body',
					section: 2,
					sectionTitle: 'History',
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain("sectionTitle is only valid when section='new'");
		});

		it('rejects sectionTitle when section is undefined', async () => {
			const { ctx } = fakeEdit();
			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'body',
					sectionTitle: 'History',
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain("sectionTitle is only valid when section='new'");
		});
	});

	describe('append/prepend mode', () => {
		it('mode=append sends appendtext=source and omits text', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: '\n* New entry',
					mode: 'append',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({ appendtext: '\n* New entry' });
			expect(params).not.toHaveProperty('text');
			expect(params).not.toHaveProperty('prependtext');
		});

		it('mode=prepend sends prependtext=source and omits text', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'intro\n',
					mode: 'prepend',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({ prependtext: 'intro\n' });
			expect(params).not.toHaveProperty('text');
			expect(params).not.toHaveProperty('appendtext');
		});

		it('mode=append composes with section=2', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: '\n* row',
					section: 2,
					mode: 'append',
				},
				ctx,
			);

			const params = submit.mock.calls[0][1];
			expect(params).toMatchObject({ section: '2', appendtext: '\n* row' });
			expect(params).not.toHaveProperty('text');
		});

		it("rejects mode combined with section='new'", async () => {
			const { ctx } = fakeEdit();
			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'body',
					section: 'new',
					sectionTitle: 'History',
					mode: 'append',
				},
				ctx,
			);

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain("mode is not compatible with section='new'");
		});
	});
});
