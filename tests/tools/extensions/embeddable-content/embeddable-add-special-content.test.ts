import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';
import { embeddableAddSpecialContent } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-special-content.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const CREATED = {
	content: { entityId: 'Q777', entityType: 'item', latestRevisionId: 12, created: true },
};

const UPDATED = {
	content: { entityId: 'Q777', entityType: 'item', latestRevisionId: 13, updated: true },
};

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function contextWith(result: unknown = CREATED, request?: (p: unknown) => unknown) {
	const submit = vi.fn().mockResolvedValue(result);
	const mock = createMockMwn({ request: vi.fn(request ?? (() => ({}))) });
	const ctx = fakeContext({
		mwn: async () => mock as never,
		edit: { ...baseEdit, submit },
	});
	return { mock, ctx, submit };
}

describe('embeddable-add-special-content', () => {
	it('forwards the raw fields to the wiki action=addspecialcontent module', async () => {
		const { ctx, submit } = contextWith();

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'Ada was first',
				content: 'Ada was first.',
				attributedTo: 'Q94',
				source: 'Q96',
				sourceUrl: 'https://example.org/page',
				date: '1843-12-01',
			}),
			ctx,
		);

		// Content is passed RAW: the wiki trims, strips math delimiters and
		// backslash-escapes (the tool no longer re-implements the payload).
		expect(submit.mock.calls[0][1]).toMatchObject({
			action: 'addspecialcontent',
			kind: 'quotation',
			label: 'Ada was first',
			content: 'Ada was first.',
			attributedTo: 'Q94',
			source: 'Q96',
			sourceUrl: 'https://example.org/page',
			date: '1843-12-01',
		});
		expect(assertStructuredData(result)).toMatchObject({
			entityId: 'Q777',
			latestRevisionId: 12,
			created: true,
		});
	});

	it('forwards the math note and the quotation translations', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'math',
				label: 'E = mc²',
				content: 'E = mc^2',
				note: 'See $E$ for the energy.',
			}),
			ctx,
		);
		expect(submit.mock.calls[0][1]).toMatchObject({ note: 'See $E$ for the energy.' });

		const second = contextWith();
		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'q',
				content: 'hi',
				attributedTo: 'Q94',
				translations: '[{"language":"fr","content":"salut"}]',
			}),
			second.ctx,
		);
		expect(second.submit.mock.calls[0][1]).toMatchObject({
			translations: '[{"language":"fr","content":"salut"}]',
		});
	});

	it('leaves blank fields out of the request', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'code-snippet',
				label: 'loop',
				content: 'for i in x',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).not.toHaveProperty('attributedTo');
		expect(params).not.toHaveProperty('language');
		expect(params).not.toHaveProperty('programmingLanguage');
	});

	it('resolves a programmingLanguage label to its item id before calling', async () => {
		const { ctx, submit } = contextWith(CREATED, () => ({
			search: [
				{ id: 'Q57', label: 'Python' },
				{ id: 'Q58', label: 'Python (programming language)' },
			],
		}));

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'code-snippet',
				label: 'loop',
				content: 'for i in x',
				programmingLanguage: 'Python',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ programmingLanguage: 'Q57' });
	});

	it('errors when a programmingLanguage label resolves to nothing', async () => {
		const { ctx, submit } = contextWith(CREATED, () => ({ search: [] }));

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'code-snippet',
				label: 'loop',
				content: 'for i in x',
				programmingLanguage: 'Nope',
			}),
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('neither an item ID nor an English label');
		expect(submit).not.toHaveBeenCalled();
	});

	it('forwards qid (uppercased) for an update', async () => {
		const { ctx, submit } = contextWith(UPDATED);

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				qid: 'q777',
				content: 'New words.',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).toMatchObject({ action: 'addspecialcontent', qid: 'Q777' });
		expect(params).not.toHaveProperty('label');
		expect(assertStructuredData(result)).toMatchObject({ entityId: 'Q777', updated: true });
	});

	it('passes the comment as the edit summary', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'x',
				content: 'y',
				attributedTo: 'Q6',
				comment: 'adding the quote',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ summary: 'adding the quote' });
	});

	it('reports a duplication-guard refusal as a not-created result naming the duplicate', async () => {
		const { ctx } = contextWith({
			content: {
				duplicate: '1',
				duplicateOf: 'Q777',
				duplicateLabel: 'Ada was first',
				match: 'label',
			},
		});

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'Ada was first',
				content: 'Ada was first.',
				attributedTo: 'Q6',
			}),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({
			notCreated: 'duplicate',
			duplicateOf: 'Q777',
			duplicateLabel: 'Ada was first',
			match: 'label',
		});
	});

	it('forwards confirmDuplicate to force a create past the guard', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'x',
				content: 'y',
				attributedTo: 'Q6',
				confirmDuplicate: true,
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ confirmDuplicate: '1' });
	});

	it('checks the term store when a create response is lost and the item exists', async () => {
		const { ctx } = contextWith({}, () => ({
			search: [{ id: 'Q777', label: 'x' }],
		}));

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'x',
				content: 'y',
				attributedTo: 'Q6',
			}),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({
			outcome: 'likely-created',
			entityId: 'Q777',
		});
	});

	it('searches the term store in the label language of the create', async () => {
		const { ctx, mock } = contextWith({}, () => ({
			search: [{ id: 'Q777', label: 'x' }],
		}));

		await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'x',
				content: 'y',
				attributedTo: 'Q6',
				labelLanguage: 'fr',
			}),
			ctx,
		);

		expect(mock.request).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'wbsearchentities', search: 'x', language: 'fr' }),
		);
	});

	it('reports a lost create response as retry-safe when no matching item exists', async () => {
		const { ctx } = contextWith({});

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				label: 'x',
				content: 'y',
				attributedTo: 'Q6',
			}),
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('was not created');
		expect(envelope.message).toContain('retrying the call is safe');
	});

	it('reports a lost update response as safe to re-run, without a search', async () => {
		const { ctx, mock } = contextWith({});

		const result = await embeddableAddSpecialContent.handle(
			toolArgs(embeddableAddSpecialContent, {
				kind: 'quotation',
				qid: 'q777',
				content: 'New words.',
			}),
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('update of Q777');
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('surfaces wiki-side rejections as errors via the dispatcher', async () => {
		const submit = vi
			.fn()
			.mockRejectedValue(new Error('kind quotation does not accept the field(s) describes.'));
		const mock = createMockMwn({ request: vi.fn(() => ({})) });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submit },
		});

		const result = await dispatch(
			embeddableAddSpecialContent,
			ctx,
		)({
			kind: 'quotation',
			label: 'x',
			content: 'y',
			attributedTo: 'Q6',
			describes: 'Q5',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('does not accept the field(s) describes');
	});

	it('is annotated as a write tool so the read-only gate covers it', () => {
		expect(embeddableAddSpecialContent.annotations.readOnlyHint).toBe(false);
	});
});
