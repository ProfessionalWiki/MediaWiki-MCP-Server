import { describe, it, expect, vi } from 'vitest';
import type { Mwn } from 'mwn';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { updatePage } from '../../src/tools/update-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { assertRefusedArgument, callTool } from '../helpers/callTool.ts';
import type { SectionEntry } from '../../src/services/sectionService.ts';

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

const JAPAN_OUTLINE: SectionEntry[] = [
	{ index: '1', level: 2, line: 'Etymology', editable: true },
	{ index: '2', level: 2, line: 'History', editable: true },
	{ index: '3', level: 3, line: 'Prehistoric to classical history', editable: true },
	{ index: '4', level: 3, line: 'Feudal era', editable: true },
	{ index: '5', level: 3, line: 'Modern era', editable: true },
	{ index: '6', level: 2, line: 'Geography', editable: true },
];

// `sourceSections` is what the wiki's parser reports for the submitted source.
// Left out, the call throws, so a test that reaches the source parse without
// having stated what it returns fails loudly rather than passing by accident.
function fakeEditWithOutline(
	outline: SectionEntry[] = JAPAN_OUTLINE,
	sourceSections?: SectionEntry[],
) {
	const base = fakeEdit();
	const list = vi.fn().mockResolvedValue(outline);
	const listInSource =
		sourceSections === undefined
			? vi.fn(() => {
					throw new Error('fakeEditWithOutline: listInSource called but not stubbed');
				})
			: vi.fn().mockResolvedValue(sourceSections);
	const ctx = fakeContext({
		mwn: async () => base.mock as never,
		edit: base.ctx.edit,
		sections: { list, listInSource },
	});
	return { ...base, ctx, list, listInSource };
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
			const { submit, ctx } = fakeEditWithOutline([]);

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
				// Section 99 does not exist, so a real outline would not contain it
				// either; the guard must not fire and it must not eat this error.
				sections: { list: vi.fn().mockResolvedValue([]), listInSource: vi.fn() },
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

			expect(assertRefusedArgument(result)).toContain("operation='append'");
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
			const { submit, ctx } = fakeEditWithOutline([]);

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
			const { submit, ctx } = fakeEditWithOutline([]);

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

	describe('subsection guard', () => {
		it('refuses a replace that would drop the subsections, naming them', async () => {
			const { submit, ctx, listInSource } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
			});

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('Feudal era');
			expect(envelope.message).toContain('removeSubsections');
			expect(submit).not.toHaveBeenCalled();
			// The source the caller sent is what gets parsed, in the page's context.
			expect(listInSource).toHaveBeenCalledWith(
				expect.anything(),
				'Japan',
				'== History ==\nRewritten.',
			);
		});

		it('allows a replace that carries the subsections back', async () => {
			const { submit, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
				{ index: '2', level: 3, line: 'Prehistoric to classical history', editable: true },
				{ index: '3', level: 3, line: 'Feudal era', editable: true },
				{ index: '4', level: 3, line: 'Modern era', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source:
					'== History ==\nIntro.\n\n=== Prehistoric to classical history ===\na\n\n=== Feudal era ===\nb\n\n=== Modern era ===\nc',
				section: 2,
			});

			assertStructuredSuccess(result);
			expect(submit).toHaveBeenCalledTimes(1);
		});

		// Counting rather than matching names is what lets a rename through.
		it('allows a replace that renames a subsection', async () => {
			const { submit, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
				{ index: '2', level: 3, line: 'Prehistory', editable: true },
				{ index: '3', level: 3, line: 'Feudal period', editable: true },
				{ index: '4', level: 3, line: 'Modern era', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source:
					'== History ==\nIntro.\n\n=== Prehistory ===\na\n\n=== Feudal period ===\nb\n\n=== Modern era ===\nc',
				section: 2,
			});

			assertStructuredSuccess(result);
			expect(submit).toHaveBeenCalledTimes(1);
		});

		// A template in the source may expand to headings, but those are not
		// content the caller wrote back — dropping three written subsections in
		// favour of a template that renders three is still a removal.
		it('does not count template-expanded headings as carried back', async () => {
			const { submit, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
				{ index: 'T-1', level: 3, line: 'Expanded a', editable: false },
				{ index: 'T-2', level: 3, line: 'Expanded b', editable: false },
				{ index: 'T-3', level: 3, line: 'Expanded c', editable: false },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\n{{ThreeHeadings}}',
				section: 2,
			});

			assertStructuredError(result, 'invalid_input');
			expect(submit).not.toHaveBeenCalled();
		});

		it('allows the destructive replace when removeSubsections is set', async () => {
			const { submit, ctx } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
				removeSubsections: true,
			});

			assertStructuredSuccess(result);
			expect(submit).toHaveBeenCalledTimes(1);
		});

		it('does not guard a section that has no subsections', async () => {
			const { submit, ctx, listInSource } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== Etymology ==\nRewritten.',
				section: 1,
			});

			assertStructuredSuccess(result);
			expect(submit).toHaveBeenCalledTimes(1);
			// The source parse is the guard's second request; a leaf section must
			// not pay for it.
			expect(listInSource).not.toHaveBeenCalled();
		});

		// A transcluded heading can never appear as an `=` run in the host page's
		// wikitext, so the guard must not ask for something the caller cannot
		// supply. Mirrors en.wikipedia's Requests for adminship, where each
		// nomination is a transcluded subsection of the Nominations heading.
		it('does not guard a section whose children are all transcluded', async () => {
			const outline: SectionEntry[] = [
				{ index: '1', level: 2, line: 'Nominations', editable: true },
				{ index: 'T-1', level: 3, line: 'Candidate A', editable: false },
				{ index: 'T-2', level: 3, line: 'Candidate B', editable: false },
				{ index: '2', level: 2, line: 'Closed', editable: true },
			];
			const { submit, ctx, listInSource } = fakeEditWithOutline(outline);

			const result = await callTool(ctx, 'update-page', {
				title: 'Wikipedia:Requests for adminship',
				source: '== Nominations ==\nIntro.\n{{RfA/Candidate A}}\n{{RfA/Candidate B}}',
				section: 1,
			});

			assertStructuredSuccess(result);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(listInSource).not.toHaveBeenCalled();
		});

		it('guards on an editable child only, naming just that child, when a sibling child is transcluded', async () => {
			const outline: SectionEntry[] = [
				{ index: '1', level: 2, line: 'Nominations', editable: true },
				{ index: '2', level: 3, line: 'Discussion', editable: true },
				{ index: 'T-1', level: 3, line: 'Candidate A', editable: false },
				{ index: '3', level: 2, line: 'Closed', editable: true },
			];
			const { submit, ctx } = fakeEditWithOutline(outline, [
				{ index: '1', level: 2, line: 'Nominations', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Wikipedia:Requests for adminship',
				source: '== Nominations ==\nRewritten, dropping the discussion subsection.',
				section: 1,
			});

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('Discussion');
			expect(envelope.message).not.toContain('Candidate A');
			expect(submit).not.toHaveBeenCalled();
		});

		// An append cannot remove existing content, so there is nothing to guard.
		it('does not guard an append to a parent section', async () => {
			const { ctx, list } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '\n\nMore.',
				section: 2,
				mode: 'append',
			});

			assertStructuredSuccess(result);
			expect(list).not.toHaveBeenCalled();
		});

		it('does not fetch an outline for a full-page replace', async () => {
			const { ctx, list } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: 'Whole new page.',
			});

			assertStructuredSuccess(result);
			expect(list).not.toHaveBeenCalled();
		});

		// The lead has no heading; rvsection=0 addresses only the text above the
		// first heading, so it can never contain a subsection.
		it('does not guard the lead section', async () => {
			const { ctx, list } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: 'New lead.',
				section: 0,
			});

			assertStructuredSuccess(result);
			expect(list).not.toHaveBeenCalled();
		});

		// Failing closed means the edit must not proceed on a best-effort basis
		// when the outline itself cannot be fetched.
		it('fails closed and never submits when the outline fetch fails', async () => {
			const { submit, ctx: base } = fakeEdit();
			const ctx = fakeContext({
				...base,
				sections: {
					list: vi.fn().mockRejectedValue(new Error('parse request failed')),
					listInSource: vi.fn(),
				},
			});

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('parse request failed');
			expect(submit).not.toHaveBeenCalled();
		});

		// The source parse is the guard's other request; its failure must not
		// downgrade the guard to best-effort either.
		it('fails closed and never submits when the source parse fails', async () => {
			const { submit, ctx: base } = fakeEdit();
			const ctx = fakeContext({
				...base,
				sections: {
					list: vi.fn().mockResolvedValue(JAPAN_OUTLINE),
					listInSource: vi.fn().mockRejectedValue(new Error('source parse failed')),
				},
			});

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('source parse failed');
			expect(submit).not.toHaveBeenCalled();
		});
	});
});

describe('update-page find-replace', () => {
	const PAGE =
		'Lead text.\n\n== History ==\nThe city was founded in 1104.\n\n== Geography ==\nThe river runs east.\n';

	// The whole point of the operation is that the server holds the page and the
	// caller holds only the text it is changing, so the read is part of the tool.
	function fakeFindReplace(current: string = PAGE, revid = 41) {
		const base = fakeEdit();
		const read = vi.fn().mockResolvedValue({
			pageid: 5,
			title: 'My Page',
			revisions: [{ revid, content: current }],
		});
		const mock = createMockMwn({
			read,
			request: base.request,
			getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
		});
		const ctx = fakeContext({ mwn: async () => mock as never, edit: base.ctx.edit });
		return { ...base, ctx, read };
	}

	it('rewrites the single match and submits the whole target', async () => {
		const { submit, ctx } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		assertStructuredSuccess(result);
		expect(submit.mock.calls[0][1]).toMatchObject({
			text: PAGE.replace('founded in 1104', 'founded in 1105'),
			nocreate: true,
			// The base for the server's own splice is the revision it just read,
			// not a revision the caller named.
			baserevid: 41,
		});
	});

	it('leaves every byte outside the match alone', async () => {
		const { submit, ctx } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'The river runs east.',
			replaceWith: 'The river runs west.',
		});

		const written = submit.mock.calls[0][1].text as string;
		expect(written).toContain('Lead text.');
		expect(written).toContain('The city was founded in 1104.');
		expect(written.length).toBe(PAGE.length);
	});

	it('refuses when find matches nothing, and says where to copy it from', async () => {
		const { submit, ctx } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1204',
			replaceWith: 'founded in 1105',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('did not appear');
		expect(envelope.message).toContain('get-page');
		expect(submit).not.toHaveBeenCalled();
	});

	// A retried call whose first attempt landed looks exactly like a bad anchor,
	// so the refusal distinguishes them.
	it('reports that the replacement is already present when find is gone', async () => {
		const { ctx, submit } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1105',
			replaceWith: 'The river runs east.',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('already present');
		expect(submit).not.toHaveBeenCalled();
	});

	// Claiming an edit already landed when it did not costs the caller its change,
	// so a replacement that merely happens to occur does not earn the claim.
	it('does not claim the edit landed when replaceWith is a short incidental match', async () => {
		const { ctx, submit } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1204',
			replaceWith: 'e',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('did not appear');
		expect(envelope.message).not.toContain('already present');
		expect(submit).not.toHaveBeenCalled();
	});

	it('refuses when find matches more than once, naming the count', async () => {
		const { submit, ctx } = fakeFindReplace('a\nrepeat me\nb\nrepeat me\nc\nrepeat me\n');

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'repeat me',
			replaceWith: 'once',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('3 times');
		expect(submit).not.toHaveBeenCalled();
	});

	it('narrows both the search and the write to one section', async () => {
		const { submit, ctx, read } = fakeFindReplace('== History ==\nThe river runs east.\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			section: 1,
			find: 'runs east',
			replaceWith: 'runs west',
		});

		expect(read.mock.calls[0][1]).toMatchObject({ rvsection: 1 });
		expect(submit.mock.calls[0][1]).toMatchObject({ section: '1' });
	});

	// String#replace reads $&, $1 and friends as references to the match.
	it('writes replaceWith literally, including dollar sequences', async () => {
		const { submit, ctx } = fakeFindReplace('Template call: {{foo}}\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: '{{foo}}',
			replaceWith: '{{bar|$1=$& and $$}}',
		});

		expect(submit.mock.calls[0][1].text).toBe('Template call: {{bar|$1=$& and $$}}\n');
	});

	it('deletes the matched text when replaceWith is empty', async () => {
		const { submit, ctx } = fakeFindReplace('keep\ndrop this line\nkeep\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'drop this line\n',
			replaceWith: '',
		});

		expect(submit.mock.calls[0][1].text).toBe('keep\nkeep\n');
	});

	it('reports a conflict when the page has moved on from the revision the caller read', async () => {
		const { submit, ctx } = fakeFindReplace(PAGE, 99);

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
			latestId: 41,
		});

		assertStructuredError(result, 'conflict');
		expect(submit).not.toHaveBeenCalled();
	});

	// The wiki reports this as `nosuchsection` on a write, and the dispatcher
	// turns that into not_found with this message. Reading it first must not
	// give the same condition a second name.
	it('refuses a section the page does not have, as the write path does', async () => {
		const base = fakeEdit();
		const read = vi.fn().mockResolvedValue({
			pageid: 5,
			title: 'My Page',
			revisions: [{ nosuchsection: true }],
		});
		const mock = createMockMwn({ read, request: base.request });
		const ctx = fakeContext({ mwn: async () => mock as never, edit: base.ctx.edit });

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			section: 9,
			find: 'anything',
			replaceWith: 'x',
		});

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toBe('Section 9 does not exist');
		expect(envelope.code).toBe('nosuchsection');
		expect(base.submit).not.toHaveBeenCalled();
	});

	// mwn.read follows redirects by default while the edit goes to the title the
	// caller named, so the read would resolve to the target page and the splice
	// would land the target's whole text on the redirect.
	it('reads the title it will write to, not the page it redirects to', async () => {
		const { ctx, read } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		expect(read.mock.calls[0][1]).toMatchObject({ redirects: false });
	});

	// A needle that can begin inside its own previous match names two different
	// splices; String#split reports one of them.
	it('refuses a find that overlaps itself', async () => {
		const { submit, ctx } = fakeFindReplace('x}}\n}}\n}}y');

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: '}}\n}}',
			replaceWith: 'ZZ',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('2 times');
		expect(submit).not.toHaveBeenCalled();
	});

	it('carries the comment and the bot flag like every other write', async () => {
		const { submit, ctx } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
			comment: 'date correction',
			bot: true,
		});

		expect(submit.mock.calls[0][1]).toMatchObject({ bot: true });
		expect(submit.mock.calls[0][1].summary).toContain('date correction');
	});

	// The subsection guard exists for a replace, which takes the subtree with it.
	// find-replace changes only the text it matched, so it must not consult the
	// outline at all.
	it('does not consult the section outline', async () => {
		const base = fakeEdit();
		const read = vi.fn().mockResolvedValue({
			pageid: 5,
			title: 'My Page',
			revisions: [{ revid: 41, content: '== History ==\nThe river runs east.\n' }],
		});
		const list = vi.fn();
		const mock = createMockMwn({ read, request: base.request });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: base.ctx.edit,
			sections: { list, listInSource: vi.fn() },
		});

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			section: 1,
			find: 'runs east',
			replaceWith: 'runs west',
		});

		assertStructuredSuccess(result);
		expect(list).not.toHaveBeenCalled();
	});
});

describe('update-page operation', () => {
	it('defaults to replacing the whole target', async () => {
		const { submit, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', { title: 'My Page', source: 'Whole new page' });

		expect(submit.mock.calls[0][1]).toMatchObject({ text: 'Whole new page' });
	});

	it("sends appendtext for operation='append'", async () => {
		const { submit, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: '\n* row',
		});

		expect(submit.mock.calls[0][1]).toMatchObject({ appendtext: '\n* row' });
	});

	// mode is the older spelling and stays accepted for a release.
	it('accepts mode as the older spelling of the same choice', async () => {
		const { submit, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', { title: 'My Page', source: '\n* row', mode: 'append' });

		expect(submit.mock.calls[0][1]).toMatchObject({ appendtext: '\n* row' });
	});

	it('refuses a call whose operation and mode disagree', async () => {
		const { submit, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'prepend',
			source: 'x',
			mode: 'append',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('mode');
		expect(submit).not.toHaveBeenCalled();
	});

	it('accepts operation and mode when they agree', async () => {
		const { submit, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: '\n* row',
			mode: 'append',
		});

		expect(submit.mock.calls[0][1]).toMatchObject({ appendtext: '\n* row' });
	});

	// The flag confirms that a section replace is meant to drop the subsections
	// it takes with it; no other operation takes them.
	it('refuses removeSubsections outside a section replace', async () => {
		const { submit, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: 'x',
			section: 2,
			removeSubsections: true,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('removeSubsections');
		expect(submit).not.toHaveBeenCalled();
	});

	it('refuses find-replace without find', async () => {
		const { submit, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			replaceWith: 'x',
		});

		assertStructuredError(result, 'invalid_input');
		expect(submit).not.toHaveBeenCalled();
	});

	it('refuses find-replace that also carries source', async () => {
		const { submit, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'a',
			replaceWith: 'b',
			source: 'whole page',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('source');
		expect(submit).not.toHaveBeenCalled();
	});

	it('refuses a replace with no source', async () => {
		const { submit, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', { title: 'My Page' });

		assertStructuredError(result, 'invalid_input');
		expect(submit).not.toHaveBeenCalled();
	});
});
