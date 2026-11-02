import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import {
	fakeContext,
	withoutEditAttribution,
	withWikiConfig,
	contextOn,
} from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseEditEntity } from '../../../../src/tools/extensions/wikibase/wikibase-edit-entity.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';

const SAVED = { entity: { id: 'Q1234', type: 'item', lastrevid: 987 }, success: 1 };

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function contextWith(submit = vi.fn().mockResolvedValue(SAVED)) {
	const mock = createMockMwn();
	const ctx = contextOn(mock, {
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

	describe('bot flag', () => {
		// botRight is stubbed per test. fakeContext's own version throws, so a call
		// that never asks for the flag also proves it never probes the account's rights.
		function contextWithRights(botRight = vi.fn().mockResolvedValue(true)) {
			const submit = vi.fn().mockResolvedValue(SAVED);
			const ctx = contextOn(createMockMwn(), { edit: { ...baseEdit, submit, botRight } });
			return { ctx, submit, botRight };
		}

		it('sends no bot parameter and does not probe the rights by default', async () => {
			const { ctx, submit, botRight } = contextWithRights();

			const result = await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
				ctx,
			);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
			expect(assertStructuredData(result)).not.toHaveProperty('botMarked');
		});

		it('passes bot through and reports botMarked true when the account has the right', async () => {
			const { ctx, submit } = contextWithRights();

			const result = await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, bot: true }),
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ action: 'wbeditentity', bot: true });
			expect(assertStructuredData(result)).toMatchObject({ botMarked: true });
		});

		it('flags a created entity the same way as an edited one', async () => {
			const { ctx, submit } = contextWithRights();

			await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { data: LABEL_DATA, bot: true }),
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ new: 'item', bot: true });
		});

		// MediaWiki saves the edit without the flag when the account lacks the right,
		// so the response is the only place that says the flag did not apply.
		it('reports botMarked false when the account lacks the bot right', async () => {
			const { ctx } = contextWithRights(vi.fn().mockResolvedValue(false));

			const result = await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, bot: true }),
				ctx,
			);

			expect(assertStructuredData(result)).toMatchObject({ botMarked: false });
		});

		it('omits botMarked, and still saves, when the rights probe fails', async () => {
			const { ctx } = contextWithRights(vi.fn().mockResolvedValue(undefined));

			const result = await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, bot: true }),
				ctx,
			);

			// The key is present with no value, and JSON serialisation drops it, as for
			// the page tools, so the caller sees no botMarked at all.
			const data = assertStructuredData(result);
			expect(data).toMatchObject({ entityId: 'Q1234' });
			expect(data.botMarked).toBeUndefined();
		});

		it('flags the edit when the wiki is configured to, without the call asking', async () => {
			const { ctx, submit } = contextWithRights();

			const result = await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA }),
				withWikiConfig(ctx, { bot: true }),
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ bot: true });
			expect(assertStructuredData(result)).toMatchObject({ botMarked: true });
		});

		it('lets a call opt out of a wiki that flags every edit', async () => {
			const { ctx, submit, botRight } = contextWithRights();

			await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, bot: false }),
				withWikiConfig(ctx, { bot: true }),
			);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
		});

		it('leaves the summary suffix and the other parameters unchanged when flagging', async () => {
			const { ctx, submit } = contextWithRights();

			await wikibaseEditEntity.handle(
				toolArgs(wikibaseEditEntity, {
					entityId: 'Q1234',
					data: LABEL_DATA,
					comment: 'add label',
					bot: true,
				}),
				ctx,
			);

			expect(submit.mock.calls[0][1]).toEqual({
				action: 'wbeditentity',
				id: 'Q1234',
				data: JSON.stringify(LABEL_DATA),
				summary: 'add label (via wikibase-edit-entity on MediaWiki MCP Server)',
				bot: true,
			});
		});

		// The wiki's own refusal, here an unknown change tag, reaches the caller as
		// an error and is neither swallowed nor retried.
		it('surfaces a rejected write as an error, and does not retry it', async () => {
			const error = Object.assign(new Error('The tag "mcp" is not allowed.'), { code: 'badtags' });
			const submit = vi.fn().mockRejectedValue(error);
			const ctx = contextOn(createMockMwn(), {
				edit: { ...baseEdit, submit, botRight: vi.fn() },
			});

			const result = await dispatch(
				wikibaseEditEntity,
				ctx,
			)(toolArgs(wikibaseEditEntity, { entityId: 'Q1234', data: LABEL_DATA, bot: true }));

			assertStructuredError(result, 'invalid_input');
			expect(submit).toHaveBeenCalledTimes(1);
		});
	});
});
