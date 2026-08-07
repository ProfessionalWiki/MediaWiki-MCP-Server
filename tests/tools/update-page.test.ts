import { describe, it, expect, vi } from 'vitest';
import type { Mwn } from 'mwn';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { updatePage } from '../../src/tools/update-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { assertRefusedArgument, callTool } from '../helpers/callTool.ts';

// The default fake EditService; each test spreads it and replaces only the
// slice it exercises, so an unexpected call to another member still throws.
const baseEdit = fakeContext().edit;

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
		.mockImplementation(async (_m: Mwn, params: Record<string, unknown>) =>
			request({ ...params, token: 'csrf-token', formatversion: '2' }),
		);
	const botRight = vi.fn().mockResolvedValue(true);
	const ctx = fakeContext({
		mwn: async () => mock as never,
		edit: {
			...baseEdit,
			submit,
			applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o }),
			botRight,
		},
	});
	return { mock, request, submit, botRight, ctx };
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
					...baseEdit,
					submit: vi.fn().mockRejectedValue(new Error('Edit conflict')),
					applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o }),
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
					...baseEdit,
					submit: vi.fn().mockRejectedValue(new Error("The page you specified doesn't exist.")),
					applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o }),
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
					...baseEdit,
					submit: vi.fn().mockRejectedValue(new Error('nosuchsection: There is no section 99.')),
					applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o }),
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
	});

	describe('section=new removal', () => {
		it('refuses section=new and points at the replacement', async () => {
			const { submit, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 'new',
			});

			expect(assertRefusedArgument(result)).toContain("mode='append'");
			expect(submit).not.toHaveBeenCalled();
		});

		it("leaves zod's own message in place for a bad value other than 'new'", async () => {
			const { submit, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 'lead',
			});

			const message = assertRefusedArgument(result);
			expect(message).toContain('expected number');
			expect(message).not.toContain('no longer creates sections');
			expect(submit).not.toHaveBeenCalled();
		});

		// Unknown keys are stripped by z.object rather than refused, so the old
		// spelling cannot fail loudly here. What matters is that it never reaches
		// the wiki as a sectiontitle parameter.
		it('ignores a sectionTitle left over from the old spelling', async () => {
			const { submit, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 2,
				sectionTitle: 'History',
			});

			assertStructuredSuccess(result);
			expect(submit.mock.calls[0][1]).not.toHaveProperty('sectiontitle');
		});

		it('accepts a numeric section over a real MCP call', async () => {
			const { submit, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'new section body',
				section: 2,
			});

			assertStructuredSuccess(result);
			expect(submit.mock.calls[0][1]).toMatchObject({ section: '2', text: 'new section body' });
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
	});

	describe('bot flag', () => {
		it('forwards bot=true and reports botMarked true when the account has the bot right', async () => {
			const { submit, botRight, ctx } = fakeEdit();

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ bot: true });
			const text = assertStructuredSuccess(result);
			expect(text).toContain('Bot marked: true');
			expect(botRight).toHaveBeenCalled();
		});

		it('reports botMarked false when the account lacks the bot right', async () => {
			const { botRight, ctx } = fakeEdit();
			botRight.mockResolvedValue(false);

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('Bot marked: false');
		});

		it('omits botMarked when the rights probe fails', async () => {
			const { botRight, ctx } = fakeEdit();
			botRight.mockResolvedValue(undefined);

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).not.toContain('Bot marked');
		});

		it('omits the bot param and skips the rights probe when bot is not requested', async () => {
			const { submit, botRight, ctx } = fakeEdit();

			await updatePage.handle({ title: 'My Page', source: 'content' }, ctx);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
		});

		it('treats bot=false like an unflagged edit', async () => {
			const { submit, botRight, ctx } = fakeEdit();

			await updatePage.handle({ title: 'My Page', source: 'content', bot: false }, ctx);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
		});

		it('composes with section and mode paths', async () => {
			const { submit, ctx } = fakeEdit();

			await updatePage.handle(
				{ title: 'My Page', source: '\n* row', section: 2, mode: 'append', bot: true },
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({
				section: '2',
				appendtext: '\n* row',
				bot: true,
			});
		});
	});
});
