import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext, contextOn } from '../helpers/fakeContext.ts';
import { wikiAnswering } from '../helpers/wikiAnswering.ts';
import { updatePage } from '../../src/tools/update-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { assertRefusedArgument, callTool } from '../helpers/callTool.ts';
import type { SectionEntry } from '../../src/services/sectionService.ts';
import { EditServiceImpl } from '../../src/services/editService.ts';

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

interface WikiState {
	/** The account's rights, or the failure its rights check meets. Default: the bot right. */
	rights?: string[] | Error;
	/** The failure an edit meets, in place of `response`. */
	editFailure?: Error;
	/** The change tags the wiki is configured to add to every write. */
	tags?: string;
}

// A mock wiki behind the real edit service. It answers an edit with `response`
// and a rights check with the account's rights, and `edits()` lists the edits
// it was sent, as the service sent them.
function fakeEdit(response: unknown = successResponse(), wiki: WikiState = {}) {
	const request = vi.fn(async (params: Record<string, unknown>) => {
		if (params.meta === 'userinfo') {
			if (wiki.rights instanceof Error) {
				throw wiki.rights;
			}
			return { query: { userinfo: { rights: wiki.rights ?? ['bot'] } } };
		}
		if (params.action === 'edit') {
			if (wiki.editFailure !== undefined) {
				throw wiki.editFailure;
			}
			return response;
		}
		return {};
	});
	const mock = createMockMwn({
		request,
		getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
	});
	const ctx = contextOn(mock, { edit: new EditServiceImpl(wiki.tags ?? null) });
	const sent = (): Record<string, unknown>[] => request.mock.calls.map(([params]) => params);
	const edits = () => sent().filter((params) => params.action === 'edit');
	const rightsChecked = () => sent().some((params) => params.meta === 'userinfo');
	return { mock, request, edits, rightsChecked, ctx };
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
	const ctx = contextOn(base.mock, {
		edit: base.ctx.edit,
		sections: { list, listInSource },
	});
	return { ...base, ctx, list, listInSource };
}

const PAGE =
	'Lead text.\n\n== History ==\nThe city was founded in 1104.\n\n== Geography ==\nThe river runs east.\n';

// The whole point of the operation is that the server holds the page and the
// caller holds only the text it is changing, so the read is part of the tool.
function fakeFindReplace(current: string = PAGE, revid = 41) {
	return fakeFindReplaceOf({
		pageid: 5,
		title: 'My Page',
		revisions: [{ revid, content: current }],
	});
}

// A wiki holding `page`: the read gets it back, and the write goes to fakeEdit's.
function fakeFindReplaceOf(page: object) {
	const base = fakeEdit();
	const request = vi.fn(async (params: { action?: string }) =>
		params.action === 'query' ? { query: { pages: [page] } } : base.request(params),
	);
	const mock = createMockMwn({
		request,
		getCsrfToken: vi.fn().mockResolvedValue('csrf-token'),
	});
	const ctx = contextOn(mock, { edit: base.ctx.edit });
	const pageReads = (): Record<string, unknown>[] =>
		request.mock.calls.map(([params]) => params).filter((params) => params.action === 'query');
	return { ...base, ctx, pageReads };
}

describe('update-page', () => {
	describe('full-page replacement', () => {
		it('sends text=source with nocreate and baserevid for conflict detection', async () => {
			const { edits, ctx } = fakeEdit();

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

			const params = edits()[0];
			expect(params).toMatchObject({
				action: 'edit',
				title: 'My Page',
				text: 'Updated content',
				nocreate: true,
				baserevid: 41,
			});
			expect(params.summary).toContain('edit summary');
			expect(params).toMatchObject({ token: 'csrf-token', formatversion: '2' });
		});

		it('omits baserevid when latestId is not supplied', async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'content',
				},
				ctx,
			);

			const params = edits()[0];
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
			const { ctx } = fakeEdit(successResponse(), { editFailure: new Error('Edit conflict') });

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
			const { ctx } = fakeEdit(successResponse(), {
				editFailure: new Error("The page you specified doesn't exist."),
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
		it("tags the edit with the wiki's configured tags", async () => {
			const { edits, ctx } = fakeEdit(successResponse(), { tags: 'mcp-edit' });

			await updatePage.handle({ title: 'Tagged', source: 'content' }, ctx);

			expect(edits()[0]).toMatchObject({ tags: 'mcp-edit' });
		});
	});

	describe('section editing', () => {
		it("forwards section=2 as section='2' with text=source", async () => {
			const { edits, ctx } = fakeEditWithOutline([]);

			const result = await updatePage.handle(
				{
					title: 'My Page',
					source: 'new section body',
					section: 2,
					latestId: 41,
				},
				ctx,
			);

			expect(result.isError).toBeFalsy();
			const params = edits()[0];
			expect(params).toMatchObject({ section: '2', text: 'new section body' });
		});

		it("forwards section=0 (lead) as section='0'", async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'lead',
					section: 0,
					latestId: 41,
				},
				ctx,
			);

			expect(edits()[0]).toMatchObject({ section: '0' });
		});

		it('maps nosuchsection error to a friendly message via dispatcher', async () => {
			const wiki = fakeEdit(successResponse(), {
				editFailure: new Error('nosuchsection: There is no section 99.'),
			});
			const ctx = {
				...wiki.ctx,
				// Section 99 does not exist, so a real outline would not contain it
				// either; the guard must not fire and it must not eat this error.
				sections: { list: vi.fn().mockResolvedValue([]), listInSource: vi.fn() },
			};

			const result = await dispatch(
				updatePage,
				ctx,
			)({
				title: 'My Page',
				source: 'x',
				section: 99,
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'not_found');
			expect(envelope.message).toBe('Section 99 does not exist');
		});
	});

	describe('section=new removal', () => {
		it('refuses section=new and points at the replacement', async () => {
			const { edits, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 'new',
			});

			expect(assertRefusedArgument(result)).toContain("operation='append'");
			expect(edits()).toHaveLength(0);
		});

		it("leaves zod's own message in place for a bad value other than 'new'", async () => {
			const { edits, ctx } = fakeEdit();

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 'lead',
			});

			const message = assertRefusedArgument(result);
			expect(message).toContain('expected number');
			expect(message).not.toContain('no longer creates sections');
			expect(edits()).toHaveLength(0);
		});

		// Unknown keys are stripped by z.object rather than refused, so the old
		// spelling cannot fail loudly here. What matters is that it never reaches
		// the wiki as a sectiontitle parameter.
		it('ignores a sectionTitle left over from the old spelling', async () => {
			const { edits, ctx } = fakeEditWithOutline([]);

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'body',
				section: 2,
				latestId: 41,
				sectionTitle: 'History',
			});

			assertStructuredSuccess(result);
			expect(edits()[0]).not.toHaveProperty('sectiontitle');
		});

		it('accepts a numeric section over a real MCP call', async () => {
			const { edits, ctx } = fakeEditWithOutline([]);

			const result = await callTool(ctx, 'update-page', {
				title: 'My Page',
				source: 'new section body',
				section: 2,
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(edits()[0]).toMatchObject({ section: '2', text: 'new section body' });
		});
	});

	describe('append/prepend mode', () => {
		it('mode=append sends appendtext=source and omits text', async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: '\n* New entry',
					mode: 'append',
				},
				ctx,
			);

			const params = edits()[0];
			expect(params).toMatchObject({ appendtext: '\n* New entry' });
			expect(params).not.toHaveProperty('text');
			expect(params).not.toHaveProperty('prependtext');
		});

		it('mode=prepend sends prependtext=source and omits text', async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: 'intro\n',
					mode: 'prepend',
				},
				ctx,
			);

			const params = edits()[0];
			expect(params).toMatchObject({ prependtext: 'intro\n' });
			expect(params).not.toHaveProperty('text');
			expect(params).not.toHaveProperty('appendtext');
		});

		it('mode=append composes with section=2', async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{
					title: 'My Page',
					source: '\n* row',
					section: 2,
					mode: 'append',
				},
				ctx,
			);

			const params = edits()[0];
			expect(params).toMatchObject({ section: '2', appendtext: '\n* row' });
			expect(params).not.toHaveProperty('text');
		});
	});

	describe('bot flag', () => {
		it('forwards bot=true and reports botMarked true when the account has the bot right', async () => {
			const { edits, ctx } = fakeEdit(successResponse(), { rights: ['bot'] });

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			expect(edits()[0]).toMatchObject({ bot: true });
			const text = assertStructuredSuccess(result);
			expect(text).toContain('Bot marked: true');
		});

		it('reports botMarked false when the account lacks the bot right', async () => {
			const { ctx } = fakeEdit(successResponse(), { rights: [] });

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).toContain('Bot marked: false');
		});

		it('omits botMarked when the rights probe fails', async () => {
			const { ctx } = fakeEdit(successResponse(), { rights: new Error('rights check failed') });

			const result = await updatePage.handle(
				{ title: 'My Page', source: 'content', bot: true },
				ctx,
			);

			const text = assertStructuredSuccess(result);
			expect(text).not.toContain('Bot marked');
		});

		it('omits the bot param and skips the rights probe when bot is not requested', async () => {
			const { edits, rightsChecked, ctx } = fakeEdit();

			await updatePage.handle({ title: 'My Page', source: 'content' }, ctx);

			expect(edits()[0]).not.toHaveProperty('bot');
			expect(rightsChecked()).toBe(false);
		});

		it('treats bot=false like an unflagged edit', async () => {
			const { edits, rightsChecked, ctx } = fakeEdit();

			await updatePage.handle({ title: 'My Page', source: 'content', bot: false }, ctx);

			expect(edits()[0]).not.toHaveProperty('bot');
			expect(rightsChecked()).toBe(false);
		});

		it('composes with section and mode paths', async () => {
			const { edits, ctx } = fakeEdit();

			await updatePage.handle(
				{ title: 'My Page', source: '\n* row', section: 2, mode: 'append', bot: true },
				ctx,
			);

			expect(edits()[0]).toMatchObject({
				section: '2',
				appendtext: '\n* row',
				bot: true,
			});
		});
	});

	describe('subsection guard', () => {
		it('refuses a replace that would drop the subsections, naming them', async () => {
			const { edits, ctx, listInSource } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('Feudal era');
			expect(envelope.message).toContain('removeSubsections');
			expect(edits()).toHaveLength(0);
			// The source the caller sent is what gets parsed, in the page's context.
			expect(listInSource).toHaveBeenCalledWith(
				expect.anything(),
				'Japan',
				'== History ==\nRewritten.',
			);
		});

		it('allows a replace that carries the subsections back', async () => {
			const { edits, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
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
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(edits()).toHaveLength(1);
		});

		// Counting rather than matching names is what lets a rename through.
		it('allows a replace that renames a subsection', async () => {
			const { edits, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
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
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(edits()).toHaveLength(1);
		});

		// A template in the source may expand to headings, but those are not
		// content the caller wrote back — dropping three written subsections in
		// favour of a template that renders three is still a removal.
		it('does not count template-expanded headings as carried back', async () => {
			const { edits, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
				{ index: '1', level: 2, line: 'History', editable: true },
				{ index: 'T-1', level: 3, line: 'Expanded a', editable: false },
				{ index: 'T-2', level: 3, line: 'Expanded b', editable: false },
				{ index: 'T-3', level: 3, line: 'Expanded c', editable: false },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\n{{ThreeHeadings}}',
				section: 2,
				latestId: 41,
			});

			assertStructuredError(result, 'invalid_input');
			expect(edits()).toHaveLength(0);
		});

		it('allows the destructive replace when removeSubsections is set', async () => {
			const { edits, ctx } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== History ==\nRewritten.',
				section: 2,
				latestId: 41,
				removeSubsections: true,
			});

			assertStructuredSuccess(result);
			expect(edits()).toHaveLength(1);
		});

		it('does not guard a section that has no subsections', async () => {
			const { edits, ctx, listInSource } = fakeEditWithOutline();

			const result = await callTool(ctx, 'update-page', {
				title: 'Japan',
				source: '== Etymology ==\nRewritten.',
				section: 1,
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(edits()).toHaveLength(1);
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
			const { edits, ctx, listInSource } = fakeEditWithOutline(outline);

			const result = await callTool(ctx, 'update-page', {
				title: 'Wikipedia:Requests for adminship',
				source: '== Nominations ==\nIntro.\n{{RfA/Candidate A}}\n{{RfA/Candidate B}}',
				section: 1,
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(edits()).toHaveLength(1);
			expect(listInSource).not.toHaveBeenCalled();
		});

		it('guards on an editable child only, naming just that child, when a sibling child is transcluded', async () => {
			const outline: SectionEntry[] = [
				{ index: '1', level: 2, line: 'Nominations', editable: true },
				{ index: '2', level: 3, line: 'Discussion', editable: true },
				{ index: 'T-1', level: 3, line: 'Candidate A', editable: false },
				{ index: '3', level: 2, line: 'Closed', editable: true },
			];
			const { edits, ctx } = fakeEditWithOutline(outline, [
				{ index: '1', level: 2, line: 'Nominations', editable: true },
			]);

			const result = await callTool(ctx, 'update-page', {
				title: 'Wikipedia:Requests for adminship',
				source: '== Nominations ==\nRewritten, dropping the discussion subsection.',
				section: 1,
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'invalid_input');
			expect(envelope.message).toContain('Discussion');
			expect(envelope.message).not.toContain('Candidate A');
			expect(edits()).toHaveLength(0);
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
				latestId: 41,
			});

			assertStructuredSuccess(result);
			expect(list).not.toHaveBeenCalled();
		});

		// Failing closed means the edit must not proceed on a best-effort basis
		// when the outline itself cannot be fetched.
		it('fails closed and never submits when the outline fetch fails', async () => {
			const { edits, ctx: base } = fakeEdit();
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
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('parse request failed');
			expect(edits()).toHaveLength(0);
		});

		// The source parse is the guard's other request; its failure must not
		// downgrade the guard to best-effort either.
		it('fails closed and never submits when the source parse fails', async () => {
			const { edits, ctx: base } = fakeEdit();
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
				latestId: 41,
			});

			const envelope = assertStructuredError(result, 'upstream_failure');
			expect(envelope.message).toContain('source parse failed');
			expect(edits()).toHaveLength(0);
		});
	});
});

describe('update-page find-replace', () => {
	it('rewrites the single match and submits the whole target', async () => {
		const { edits, ctx } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		assertStructuredSuccess(result);
		expect(edits()[0]).toMatchObject({
			text: PAGE.replace('founded in 1104', 'founded in 1105'),
			nocreate: true,
			// The base for the server's own splice is the revision it just read,
			// not a revision the caller named.
			baserevid: 41,
		});
	});

	it('leaves every byte outside the match alone', async () => {
		const { edits, ctx } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'The river runs east.',
			replaceWith: 'The river runs west.',
		});

		const written = edits()[0].text as string;
		expect(written).toContain('Lead text.');
		expect(written).toContain('The city was founded in 1104.');
		expect(written.length).toBe(PAGE.length);
	});

	it('refuses when find matches nothing, and says where to copy it from', async () => {
		const { edits, ctx } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1204',
			replaceWith: 'founded in 1105',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('did not appear');
		expect(envelope.message).toContain('get-page');
		expect(edits()).toHaveLength(0);
	});

	// A retried call whose first attempt landed looks exactly like a bad anchor,
	// so the refusal distinguishes them.
	it('reports that the replacement is already present when find is gone', async () => {
		const { ctx, edits } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1105',
			replaceWith: 'The river runs east.',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('already present');
		expect(edits()).toHaveLength(0);
	});

	// Claiming an edit already landed when it did not costs the caller its change,
	// so a replacement that merely happens to occur does not earn the claim.
	it('does not claim the edit landed when replaceWith is a short incidental match', async () => {
		const { ctx, edits } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1204',
			replaceWith: 'e',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('did not appear');
		expect(envelope.message).not.toContain('already present');
		expect(edits()).toHaveLength(0);
	});

	it('refuses when find matches more than once, naming the count', async () => {
		const { edits, ctx } = fakeFindReplace('a\nrepeat me\nb\nrepeat me\nc\nrepeat me\n');

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'repeat me',
			replaceWith: 'once',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('3 times');
		expect(edits()).toHaveLength(0);
	});

	it('narrows both the search and the write to one section', async () => {
		const { edits, ctx, pageReads } = fakeFindReplace('== History ==\nThe river runs east.\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			section: 1,
			find: 'runs east',
			replaceWith: 'runs west',
		});

		expect(pageReads()).toEqual([expect.objectContaining({ rvsection: 1 })]);
		expect(edits()[0]).toMatchObject({ section: '1' });
	});

	// String#replace reads $&, $1 and friends as references to the match.
	it('writes replaceWith literally, including dollar sequences', async () => {
		const { edits, ctx } = fakeFindReplace('Template call: {{foo}}\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: '{{foo}}',
			replaceWith: '{{bar|$1=$& and $$}}',
		});

		expect(edits()[0].text).toBe('Template call: {{bar|$1=$& and $$}}\n');
	});

	it('deletes the matched text when replaceWith is empty', async () => {
		const { edits, ctx } = fakeFindReplace('keep\ndrop this line\nkeep\n');

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'drop this line\n',
			replaceWith: '',
		});

		expect(edits()[0].text).toBe('keep\nkeep\n');
	});

	it("fails with the wiki's refusal when the read is refused", async () => {
		const wiki = wikiAnswering({
			error: { code: 'readapidenied', info: 'You need read permission to use this module.' },
		});

		const result = await callTool(contextOn(wiki.mwn), 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		assertStructuredError(result, 'permission_denied', 'readapidenied');
	});

	it('reports a conflict when the page has moved on from the revision the caller read', async () => {
		const { edits, ctx } = fakeFindReplace(PAGE, 99);

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
			latestId: 41,
		});

		assertStructuredError(result, 'conflict');
		expect(edits()).toHaveLength(0);
	});

	// The wiki reports this as `nosuchsection` on a write, and the dispatcher
	// turns that into not_found with this message. Reading it first must not
	// give the same condition a second name.
	it('refuses a section the page does not have, as the write path does', async () => {
		const base = fakeFindReplaceOf({
			pageid: 5,
			title: 'My Page',
			revisions: [{ nosuchsection: true }],
		});
		const { ctx } = base;

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
		expect(base.edits()).toHaveLength(0);
	});

	// The edit goes to the title the caller named, so a read that followed the
	// redirect would resolve to the target page and the splice would land the
	// target's whole text on the redirect.
	it('reads the title it will write to, not the page it redirects to', async () => {
		const { ctx, pageReads } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		expect(pageReads()).toEqual([expect.objectContaining({ redirects: false })]);
	});

	// A needle that can begin inside its own previous match names two different
	// splices; String#split reports one of them.
	it('refuses a find that overlaps itself', async () => {
		const { edits, ctx } = fakeFindReplace('x}}\n}}\n}}y');

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: '}}\n}}',
			replaceWith: 'ZZ',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('2 times');
		expect(edits()).toHaveLength(0);
	});

	it('carries the comment and the bot flag like every other write', async () => {
		const { edits, ctx } = fakeFindReplace();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
			comment: 'date correction',
			bot: true,
		});

		expect(edits()[0]).toMatchObject({ bot: true });
		expect(edits()[0].summary).toContain('date correction');
	});

	// The subsection guard exists for a replace, which takes the subtree with it.
	// find-replace changes only the text it matched, so it must not consult the
	// outline at all.
	it('does not consult the section outline', async () => {
		const base = fakeFindReplace('== History ==\nThe river runs east.\n');
		const list = vi.fn();
		const ctx = { ...base.ctx, sections: { list, listInSource: vi.fn() } };

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
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', { title: 'My Page', source: 'Whole new page' });

		expect(edits()[0]).toMatchObject({ text: 'Whole new page' });
	});

	it("sends appendtext for operation='append'", async () => {
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: '\n* row',
		});

		expect(edits()[0]).toMatchObject({ appendtext: '\n* row' });
	});

	// mode is the older spelling and stays accepted for a release.
	it('accepts mode as the older spelling of the same choice', async () => {
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', { title: 'My Page', source: '\n* row', mode: 'append' });

		expect(edits()[0]).toMatchObject({ appendtext: '\n* row' });
	});

	it('refuses a call whose operation and mode disagree', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'prepend',
			source: 'x',
			mode: 'append',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('mode');
		expect(edits()).toHaveLength(0);
	});

	it('accepts operation and mode when they agree', async () => {
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: '\n* row',
			mode: 'append',
		});

		expect(edits()[0]).toMatchObject({ appendtext: '\n* row' });
	});

	// The flag confirms that a section replace is meant to drop the subsections
	// it takes with it; no other operation takes them.
	it('refuses removeSubsections outside a section replace', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: 'x',
			section: 2,
			removeSubsections: true,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('removeSubsections');
		expect(edits()).toHaveLength(0);
	});

	it('refuses find-replace without find', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			replaceWith: 'x',
		});

		assertStructuredError(result, 'invalid_input');
		expect(edits()).toHaveLength(0);
	});

	it('refuses find-replace that also carries source', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			find: 'a',
			replaceWith: 'b',
			source: 'whole page',
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('source');
		expect(edits()).toHaveLength(0);
	});

	it('refuses a replace with no source', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', { title: 'My Page' });

		assertStructuredError(result, 'invalid_input');
		expect(edits()).toHaveLength(0);
	});
});

// A section number means nothing without the revision it was read from: the wiki
// resolves it against whatever the page is now, so an index that has since
// shifted addresses a different section.
describe('update-page section base revision', () => {
	it('refuses a section replace without latestId', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'body',
			section: 2,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('latestId');
		expect(envelope.message).toContain('get-page');
		expect(edits()).toHaveLength(0);
	});

	// The lead is always section 0, and no insertion moves it, so there is no
	// ambiguity to resolve and nothing to require.
	it('leaves a lead replace alone', async () => {
		const { edits, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, []);

		await callTool(ctx, 'update-page', { title: 'Japan', source: 'new lead', section: 0 });

		expect(edits()).toHaveLength(1);
	});

	// A delta put in the wrong section is misplaced, not lost, and shows in the
	// diff, so it is not worth refusing a call over.
	it.each(['append', 'prepend'])('leaves a %s scoped to a section alone', async (operation) => {
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation,
			source: 'body',
			section: 2,
		});

		expect(edits()).toHaveLength(1);
	});

	// The payoff of requiring it: the wiki resolves the index against this
	// revision rather than against whichever is current.
	it("forwards the caller's base revision on a section replace", async () => {
		const { edits, ctx } = fakeEditWithOutline(JAPAN_OUTLINE, [
			{ index: '1', level: 2, line: 'History', editable: true },
			{ index: '2', level: 3, line: 'Prehistoric to classical history', editable: true },
			{ index: '3', level: 3, line: 'Feudal era', editable: true },
			{ index: '4', level: 3, line: 'Modern era', editable: true },
		]);

		await callTool(ctx, 'update-page', {
			title: 'Japan',
			source:
				'== History ==\nkept\n\n=== Prehistoric to classical history ===\na\n\n=== Feudal era ===\nb\n\n=== Modern era ===\nc',
			section: 2,
			latestId: 41,
		});

		expect(edits()[0]).toMatchObject({ section: '2', baserevid: 41 });
	});

	// The subsection guard compares section numbers, so it has to read the
	// outline of the revision those numbers came from.
	it('reads the section outline at the revision the write names', async () => {
		const { ctx, list } = fakeEditWithOutline(JAPAN_OUTLINE, []);

		await callTool(ctx, 'update-page', {
			title: 'Japan',
			source: '== Geography ==\nrewritten',
			section: 6,
			latestId: 41,
		});

		expect(list).toHaveBeenCalledWith(expect.anything(), 'Japan', 41);
	});

	// find-replace addresses its target by the text it matches, so a shifted
	// index either fails to match or names text that genuinely holds the anchor.
	it('does not require latestId for find-replace', async () => {
		const { edits, ctx } = fakeFindReplace();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'find-replace',
			section: 1,
			find: 'founded in 1104',
			replaceWith: 'founded in 1105',
		});

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	it('leaves a whole-page write alone', async () => {
		const { edits, ctx } = fakeEdit();

		await callTool(ctx, 'update-page', { title: 'My Page', source: 'whole page' });

		expect(edits()).toHaveLength(1);
	});
});

// Content larger than one read returns cannot have been read whole through this
// server, so a replace that shortens it is discarding something unseen.
describe('update-page unread content guard', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Routed by parameter rather than by call order, so a change to how either
	// probe reads its response shows up as a failure instead of a skipped guard.
	function fakeSizedEdit(pageBytes: number, sectionContent?: string) {
		const base = fakeEdit();
		const request = vi.fn().mockImplementation((params: Record<string, unknown>) => {
			if (params.prop === 'info') {
				return Promise.resolve({ query: { pages: [{ title: 'My Page', length: pageBytes }] } });
			}
			if (params.prop === 'revisions') {
				return Promise.resolve({
					query: {
						pages: [
							{
								revisions: [
									{
										slots: {
											main: {
												...(sectionContent === undefined ? {} : { content: sectionContent }),
											},
										},
									},
								],
							},
						],
					},
				});
			}
			return base.request(params);
		});
		const mock = createMockMwn({ request, getCsrfToken: vi.fn().mockResolvedValue('t') });
		const ctx = contextOn(mock, {
			edit: base.ctx.edit,
			sections: { list: vi.fn().mockResolvedValue([]), listInSource: vi.fn() },
		});
		return { ...base, ctx, request };
	}

	const infoProbes = (request: ReturnType<typeof vi.fn>) =>
		request.mock.calls.filter((c) => c[0]?.prop === 'info');
	const sectionReads = (request: ReturnType<typeof vi.fn>) =>
		request.mock.calls.filter((c) => c[0]?.prop === 'revisions');

	it('refuses a whole-page replace that shortens a page too large to have been read', async () => {
		const { edits, ctx } = fakeSizedEdit(150000);

		const result = await callTool(ctx, 'update-page', { title: 'My Page', source: 'short' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('150000');
		expect(envelope.message).toContain("operation='find-replace'");
		expect(envelope.message).toContain('removeUnreadContent');
		expect(edits()).toHaveLength(0);
	});

	// The guard and the read cap have to agree on what "returned whole" means,
	// and truncateByBytes cuts only above the cap.
	it('allows a shortening replace of a page at exactly the cap', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
		const { edits, ctx } = fakeSizedEdit(1000);

		assertStructuredSuccess(await callTool(ctx, 'update-page', { title: 'My Page', source: 'x' }));
		expect(edits()).toHaveLength(1);
	});

	it('refuses a shortening replace of a page one byte over the cap', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '1000');
		const { edits, ctx } = fakeSizedEdit(1001);

		assertStructuredError(
			await callTool(ctx, 'update-page', { title: 'My Page', source: 'x' }),
			'invalid_input',
		);
		expect(edits()).toHaveLength(0);
	});

	// The probe must measure the page the write lands on, and mwn resolves
	// redirects unless told not to.
	it('measures the page named, not the page it redirects to', async () => {
		const { ctx, request } = fakeSizedEdit(150000);

		await callTool(ctx, 'update-page', { title: 'My Page', source: 'short' });

		expect(infoProbes(request)[0][0]).not.toHaveProperty('redirects');
	});

	// A source of multi-byte characters is longer in bytes than in characters,
	// and the target is measured in bytes.
	it('compares source and target in bytes, not characters', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '100');
		const { edits, ctx } = fakeSizedEdit(150);

		// 60 characters, 180 bytes: longer than the 150-byte page it replaces.
		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: '漢'.repeat(60),
		});

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	it('allows the shortening replace when it is confirmed', async () => {
		const { edits, ctx } = fakeSizedEdit(150000);

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			removeUnreadContent: true,
		});

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	// Nothing is measured when the confirmation has already answered the question.
	it('makes no probe at all when the replace is confirmed', async () => {
		const { ctx, request } = fakeSizedEdit(150000);

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			removeUnreadContent: true,
		});

		expect(infoProbes(request)).toHaveLength(0);
	});

	it('allows a replace that does not shorten the page', async () => {
		const { edits, ctx } = fakeSizedEdit(150000);

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'x'.repeat(150001),
		});

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	it('allows a shortening replace of a page small enough to have been read whole', async () => {
		const { edits, ctx } = fakeSizedEdit(500);

		const result = await callTool(ctx, 'update-page', { title: 'My Page', source: 'short' });

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	// No section of an under-cap page can be over it, so the section is never read.
	it('does not measure a section of a page that fits within one read', async () => {
		const { edits, ctx, request } = fakeSizedEdit(500);

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			section: 1,
			latestId: 41,
		});

		expect(sectionReads(request)).toHaveLength(0);
		expect(edits()).toHaveLength(1);
	});

	it('measures the section itself on a page too large to have been read whole', async () => {
		const { edits, ctx } = fakeSizedEdit(150000, 'y'.repeat(120000));

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			section: 1,
			latestId: 41,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('Section 1');
		expect(envelope.message).toContain('120000');
		expect(edits()).toHaveLength(0);
	});

	// The write resolves the section number against latestId, so measuring the
	// current revision would certify a section the write does not touch.
	it('measures the section at the revision the write names', async () => {
		const { ctx, request } = fakeSizedEdit(150000, 'y'.repeat(120000));

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			section: 1,
			latestId: 41,
		});

		expect(sectionReads(request)[0][0]).toMatchObject({ revids: 41, rvsection: 1 });
	});

	// The section is measured in bytes too: a section of multi-byte characters is
	// over the cap while its character count is well under it.
	it('measures the section in bytes, not characters', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '100');
		const { edits, ctx } = fakeSizedEdit(150, '漢'.repeat(50));

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'x',
			section: 1,
			latestId: 41,
		});

		assertStructuredError(result, 'invalid_input');
		expect(edits()).toHaveLength(0);
	});

	// Neither probe may opt into redirect resolution: the write goes to the title
	// the caller named, so a probe that resolves one measures a different page.
	it('never asks either probe to follow a redirect', async () => {
		const { ctx, request } = fakeSizedEdit(150000, 'y'.repeat(120000));

		await callTool(ctx, 'update-page', { title: 'My Page', source: 'short', section: 0 });

		for (const call of [...infoProbes(request), ...sectionReads(request)]) {
			expect(call[0].redirects ?? false).toBe(false);
		}
	});

	it('allows replacing a small section of a large page', async () => {
		const { edits, ctx } = fakeSizedEdit(150000, 'y'.repeat(200));

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			source: 'short',
			section: 1,
			latestId: 41,
		});

		assertStructuredSuccess(result);
		expect(edits()).toHaveLength(1);
	});

	// A source that is a truncated prefix may appear to drop subsections that
	// simply lie past the cut, so this guard answers before that one.
	it('reports the unread content before the subsections', async () => {
		const base = fakeEdit();
		const request = vi.fn().mockImplementation((params: Record<string, unknown>) => {
			if (params.prop === 'info') {
				return Promise.resolve({ query: { pages: [{ title: 'Japan', length: 150000 }] } });
			}
			if (params.prop === 'revisions') {
				return Promise.resolve({
					query: { pages: [{ revisions: [{ slots: { main: { content: 'y'.repeat(120000) } } }] }] },
				});
			}
			return base.request(params);
		});
		const mock = createMockMwn({ request, getCsrfToken: vi.fn().mockResolvedValue('t') });
		const ctx = contextOn(mock, {
			edit: base.ctx.edit,
			sections: { list: vi.fn().mockResolvedValue(JAPAN_OUTLINE), listInSource: vi.fn() },
		});

		const result = await callTool(ctx, 'update-page', {
			title: 'Japan',
			source: '== History ==\nshort',
			section: 2,
			latestId: 41,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('bytes');
		expect(envelope.message).not.toContain('subsection');
	});

	it.each(['append', 'prepend'])('never measures anything for a %s', async (operation) => {
		const { edits, ctx, request } = fakeSizedEdit(150000);

		await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation,
			source: 'x',
			section: 1,
			latestId: 41,
		});

		expect(infoProbes(request)).toHaveLength(0);
		expect(edits()).toHaveLength(1);
	});

	it('refuses removeUnreadContent outside a replace', async () => {
		const { edits, ctx } = fakeEdit();

		const result = await callTool(ctx, 'update-page', {
			title: 'My Page',
			operation: 'append',
			source: 'x',
			removeUnreadContent: true,
		});

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('removeUnreadContent');
		expect(edits()).toHaveLength(0);
	});
});
