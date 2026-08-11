import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext, withoutEditAttribution } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseEditEntity } from '../../../../src/tools/extensions/wikibase/wikibase-edit-entity.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';

const SAVED = { entity: { id: 'Q1234', type: 'item', lastrevid: 987 }, success: 1 };

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function contextWith(submit = vi.fn().mockResolvedValue(SAVED)) {
	const mock = createMockMwn();
	const ctx = fakeContext({
		mwn: async () => mock as never,
		edit: { ...baseEdit, submit },
	});
	return { mock, ctx, submit };
}

const LABEL_DATA = { labels: { en: { language: 'en', value: 'Berlin' } } };

const CLAIM_DATA = {
	claims: [
		{
			mainsnak: { snaktype: 'value', property: 'P31' },
			type: 'statement',
			rank: 'normal',
		},
	],
};

describe('wikibase-edit-entity', () => {
	it('creates a new entity of the requested type when no entityId is given', async () => {
		const { ctx, submit } = contextWith();

		const result = await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { data: LABEL_DATA }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			action: 'wbeditentity',
			new: 'item',
			data: JSON.stringify(LABEL_DATA),
		});
		expect(submit.mock.calls[0][1]).not.toHaveProperty('id');
		expect(assertStructuredData(result)).toMatchObject({
			entityId: 'Q1234',
			latestRevisionId: 987,
		});
	});

	it('creates a property when entityType is property', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { data: LABEL_DATA, entityType: 'property' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ new: 'property' });
	});

	it('edits the named entity instead of creating one', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ id: 'Q1234' });
		expect(submit.mock.calls[0][1]).not.toHaveProperty('new');
	});

	it('replaces the entity only when clear is set', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
			ctx,
		);
		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, clear: true }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).not.toHaveProperty('clear');
		expect(submit.mock.calls[1][1]).toMatchObject({ clear: true });
	});

	it('attributes the edit to the tool that made it, after the caller comment', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, comment: 'add label' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			summary: 'add label (via wikibase-edit-entity on MediaWiki MCP Server)',
		});
	});

	it('attributes an edit the caller gave no comment for', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			summary: 'Automated edit (via wikibase-edit-entity on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, comment: 'add label' }),
			withoutEditAttribution(ctx),
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ summary: 'add label' });
	});

	it('goes through the edit service so the write carries a CSRF token and change tags', async () => {
		const { mock, ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
			ctx,
		);

		expect(submit).toHaveBeenCalledTimes(1);
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('reports a save that returned no entity as upstream_failure', async () => {
		const { ctx } = contextWith(vi.fn().mockResolvedValue({ success: 1 }));

		const result = await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
			ctx,
		);

		assertStructuredError(result, 'upstream_failure');
	});

	it('surfaces a rejected CSRF token as an authentication error', async () => {
		const error = Object.assign(new Error('Invalid CSRF token.'), { code: 'badtoken' });
		const { ctx } = contextWith(vi.fn().mockRejectedValue(error));

		const result = await dispatch(
			wikibaseEditEntity,
			ctx,
		)(toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }));

		assertStructuredError(result, 'authentication');
	});

	it('edits a lexeme, which serialises its statements under claims', async () => {
		const { ctx, submit } = contextWith();

		await wikibaseEditEntity.handle(
			toolArgs(wikibaseEditEntity, { entityId: 'L1', data: CLAIM_DATA }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			id: 'L1',
			data: JSON.stringify(CLAIM_DATA),
		});
	});

	it('rejects a MediaInfo id, naming the entity types its payload describes', () => {
		expect(() => toolArgs(wikibaseEditEntity, { entityId: 'M12017177', data: LABEL_DATA })).toThrow(
			/Item, property or lexeme ID/,
		);
	});

	it('is annotated as a write tool so the read-only gate covers it', () => {
		expect(wikibaseEditEntity.annotations.readOnlyHint).toBe(false);
	});
});
