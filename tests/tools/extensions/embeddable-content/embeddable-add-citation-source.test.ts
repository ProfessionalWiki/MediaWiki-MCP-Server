import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import {
	assertStructuredData,
	assertStructuredError,
	assertStructuredSuccess,
} from '../../../helpers/structuredResult.ts';
import { embeddableAddCitationSource } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-citation-source.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const CREATED = {
	source: {
		entityId: 'Q777',
		entityType: 'item',
		latestRevisionId: 12,
		created: true,
		pageTitle: 'Source:The Hobbit (Book)',
	},
};

const UPDATED = {
	source: { entityId: 'Q777', entityType: 'item', latestRevisionId: 13, updated: true },
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

describe('embeddable-add-citation-source', () => {
	it('forwards the Zotero/CSL-aligned classes and fields (contract-driven)', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'legal-case',
				title: 'Roe v. Wade',
				court: 'Q1',
				caseNumber: '410 U.S. 113',
				international: 'yes',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			action: 'addsource',
			class: 'legal-case',
			court: 'Q1',
			caseNumber: '410 U.S. 113',
			international: 'yes',
		});
	});

	it('forwards the fields to the wiki action=addsource module on create', async () => {
		const { ctx, submit } = contextWith(CREATED);

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6, Q94',
				publisher: 'Q42',
				pages: '1-300',
				year: '1937',
				isbn: '9780547928227',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).toMatchObject({
			action: 'addsource',
			class: 'book',
			title: 'The Hobbit',
			authors: 'Q6, Q94',
			publisher: 'Q42',
			pages: '1-300',
			year: '1937',
			isbn: '9780547928227',
		});
		expect(assertStructuredData(result)).toMatchObject({
			entityId: 'Q777',
			latestRevisionId: 12,
			created: true,
			pageTitle: 'Source:The Hobbit (Book)',
		});
	});

	it('leaves blank fields out of the request', async () => {
		const { ctx, submit } = contextWith(CREATED);

		await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'webpage',
				title: 'A Page',
				authors: 'Q6',
				url: 'https://example.org/page',
				parent: 'Q42',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).not.toHaveProperty('year');
		expect(params).not.toHaveProperty('isbn');
		expect(params).not.toHaveProperty('description');
		expect(params).toMatchObject({ class: 'webpage', parent: 'Q42' });
	});

	it('forwards qid (uppercased) for an update', async () => {
		const { ctx, submit } = contextWith(UPDATED);

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				qid: 'q777',
				isbn: '9780547928227',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).toMatchObject({ action: 'addsource', qid: 'Q777', isbn: '9780547928227' });
		expect(params).not.toHaveProperty('title');
		expect(assertStructuredData(result)).toMatchObject({ entityId: 'Q777', updated: true });
	});

	it('passes the comment as the edit summary', async () => {
		const { ctx, submit } = contextWith(CREATED);

		await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6',
				comment: 'adding the reference',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ summary: 'adding the reference' });
	});

	it('treats the wiki string flags (created: "1") as created', async () => {
		// MediaWiki's ApiResult serializes true as '' — the API modules
		// return '1' instead; the tool must read either form.
		const { ctx } = contextWith({
			source: { entityId: 'Q777', entityType: 'item', latestRevisionId: 12, created: '1' },
		});

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, { classKey: 'book', title: 'X', authors: 'Q6' }),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({ entityId: 'Q777', created: true });
	});

	it('reports a duplication-guard refusal as a not-created result naming the duplicate', async () => {
		const { ctx } = contextWith({
			source: {
				duplicate: '1',
				duplicateOf: 'Q777',
				duplicateLabel: 'The Hobbit (Book)',
				match: 'label',
			},
		});

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6',
			}),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({
			notCreated: 'duplicate',
			duplicateOf: 'Q777',
			duplicateLabel: 'The Hobbit (Book)',
			match: 'label',
		});
		expect(assertStructuredSuccess(result)).toContain('Not created: duplicate');
	});

	it('forwards confirmDuplicate to force a create past the guard', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6',
				confirmDuplicate: true,
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ confirmDuplicate: '1' });
	});

	it('checks the term store when a create response is lost and the item exists', async () => {
		const { ctx } = contextWith({}, () => ({
			search: [{ id: 'Q777', label: 'The Hobbit (Book)' }],
		}));

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6',
			}),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({
			outcome: 'likely-created',
			entityId: 'Q777',
		});
	});

	it('reports a lost create response as retry-safe when no matching item exists', async () => {
		const { ctx } = contextWith({});

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				title: 'The Hobbit',
				authors: 'Q6',
			}),
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('was not created');
		expect(envelope.message).toContain('retrying the call is safe');
	});

	it('reports a lost update response as safe to re-run, without a search', async () => {
		const { ctx, mock } = contextWith({});

		const result = await embeddableAddCitationSource.handle(
			toolArgs(embeddableAddCitationSource, {
				classKey: 'book',
				qid: 'q777',
				isbn: '9780547928227',
			}),
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('update of Q777');
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('surfaces wiki-side rejections as errors via the dispatcher', async () => {
		const mock = createMockMwn({ request: vi.fn() });
		const submit = vi
			.fn()
			.mockRejectedValue(new Error('classKey webpage does not expose the field(s) journal.'));
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...fakeContext().edit, submit },
		});

		const result = await dispatch(
			embeddableAddCitationSource,
			ctx,
		)({
			classKey: 'webpage',
			title: 'A Page',
			authors: 'Q6',
			journal: 'Q42',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('does not expose the field(s) journal');
	});

	it('is annotated as a write tool so the read-only gate covers it', () => {
		expect(embeddableAddCitationSource.annotations.readOnlyHint).toBe(false);
	});
});
