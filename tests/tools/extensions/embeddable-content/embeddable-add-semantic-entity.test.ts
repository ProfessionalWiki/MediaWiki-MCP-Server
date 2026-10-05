import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';
import { embeddableAddSemanticEntity } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-semantic-entity.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const CREATED = {
	semantic: {
		entityId: 'Q777',
		entityType: 'item',
		latestRevisionId: 12,
		created: true,
		pageTitle: 'Person:Ada Lovelace',
	},
};

const UPDATED = {
	semantic: { entityId: 'Q777', entityType: 'item', latestRevisionId: 13, updated: true },
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

describe('embeddable-add-semantic-entity', () => {
	it('forwards the fictional-character alias field (contract-driven)', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'fictional-character',
				givenName: 'Sherlock',
				familyName: 'Holmes',
				alias: 'The Detective, Holmes',
			}),
			ctx,
		);
		expect(submit.mock.calls[0][1]).toMatchObject({ alias: 'The Detective, Holmes' });
	});

	it('forwards the person fields to the wiki action=addsemanticentity module', async () => {
		const { ctx, submit } = contextWith();

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'person',
				givenName: 'Ada',
				familyName: 'Lovelace',
				dateOfBirth: '1815-12-10',
				orcid: '0000-0001-0002-0003',
				officialWebsite: 'https://example.org/ada',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			action: 'addsemanticentity',
			kind: 'person',
			givenName: 'Ada',
			familyName: 'Lovelace',
			dateOfBirth: '1815-12-10',
			orcid: '0000-0001-0002-0003',
			officialWebsite: 'https://example.org/ada',
		});
		// The label is derived wiki-side; nothing else is sent.
		expect(submit.mock.calls[0][1]).not.toHaveProperty('label');
		expect(assertStructuredData(result)).toMatchObject({
			entityId: 'Q777',
			latestRevisionId: 12,
			created: true,
			pageTitle: 'Person:Ada Lovelace',
		});
	});

	it('resolves a programmingLanguage label to its item id before calling', async () => {
		const { ctx, submit } = contextWith(CREATED, () => ({
			search: [{ id: 'Q57', label: 'Python' }],
		}));

		await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'software',
				label: 'Flameshot',
				programmingLanguage: 'Python',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ programmingLanguage: 'Q57' });
	});

	it('forwards qid (uppercased) for an update and the comment as summary', async () => {
		const { ctx, submit } = contextWith(UPDATED);

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'person',
				qid: 'q777',
				orcid: '0000-0002',
				comment: 'correcting the ORCID',
			}),
			ctx,
		);

		const params = submit.mock.calls[0][1];
		expect(params).toMatchObject({
			action: 'addsemanticentity',
			qid: 'Q777',
			summary: 'correcting the ORCID',
		});
		expect(assertStructuredData(result)).toMatchObject({ entityId: 'Q777', updated: true });
	});

	it('reports a duplication-guard refusal as a not-created result naming the duplicate', async () => {
		const { ctx } = contextWith({
			semantic: {
				duplicate: '1',
				duplicateOf: 'Q777',
				duplicateLabel: 'Ada Lovelace',
				match: 'label',
			},
		});

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'person',
				givenName: 'Ada',
				familyName: 'Lovelace',
			}),
			ctx,
		);

		expect(assertStructuredData(result)).toMatchObject({
			notCreated: 'duplicate',
			duplicateOf: 'Q777',
			duplicateLabel: 'Ada Lovelace',
			match: 'label',
		});
	});

	it('forwards confirmDuplicate to force a create past the guard', async () => {
		const { ctx, submit } = contextWith();

		await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'software',
				label: 'Flameshot',
				confirmDuplicate: true,
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ confirmDuplicate: '1' });
	});

	it('checks the term store when a create response is lost and the item exists', async () => {
		const { ctx } = contextWith({}, () => ({
			search: [{ id: 'Q777', label: 'Ada Lovelace' }],
		}));

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'person',
				givenName: 'Ada',
				familyName: 'Lovelace',
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

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, { kind: 'person', givenName: 'Ada' }),
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('was not created');
		expect(envelope.message).toContain('retrying the call is safe');
	});

	it('reports a lost update response as safe to re-run, without a search', async () => {
		const { ctx, mock } = contextWith({});

		const result = await embeddableAddSemanticEntity.handle(
			toolArgs(embeddableAddSemanticEntity, {
				kind: 'person',
				qid: 'q777',
				orcid: '0000-0002',
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
			.mockRejectedValue(new Error('kind software does not accept the field(s) presentInWork.'));
		const mock = createMockMwn({ request: vi.fn(() => ({})) });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submit },
		});

		const result = await dispatch(
			embeddableAddSemanticEntity,
			ctx,
		)({
			kind: 'software',
			label: 'x',
			presentInWork: 'Q42',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('does not accept the field(s) presentInWork');
	});

	it('is annotated as a write tool so the read-only gate covers it', () => {
		expect(embeddableAddSemanticEntity.annotations.readOnlyHint).toBe(false);
	});
});
