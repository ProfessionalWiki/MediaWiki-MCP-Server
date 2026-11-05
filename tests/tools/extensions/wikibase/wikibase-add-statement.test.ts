import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import {
	fakeContext,
	withoutEditAttribution,
	withWikiConfig,
	contextOn,
} from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseAddStatement } from '../../../../src/tools/extensions/wikibase/wikibase-add-statement.ts';
import { assertStructuredData, assertStructuredError } from '../../../helpers/structuredResult.ts';

const CREATED = {
	claim: { id: 'Q42$8f1a', type: 'statement', rank: 'normal' },
	pageinfo: { lastrevid: 555 },
	success: 1,
};

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function contextWith(datatype: string, submit = vi.fn().mockResolvedValue(CREATED)) {
	const mock = createMockMwn({
		request: vi.fn().mockResolvedValue({
			entities: { P31: { id: 'P31', type: 'property', datatype } },
		}),
	});
	const ctx = contextOn(mock, {
		edit: { ...baseEdit, submit },
	});
	return { mock, ctx, submit };
}

describe('wikibase-add-statement', () => {
	it('builds an item snak from a Q-id value', async () => {
		const { ctx, submit } = contextWith('wikibase-item');

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'Q5' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			action: 'wbcreateclaim',
			entity: 'Q42',
			property: 'P31',
			snaktype: 'value',
			value: JSON.stringify({ 'entity-type': 'item', id: 'Q5' }),
		});
		expect(assertStructuredData(result)).toMatchObject({
			statementId: 'Q42$8f1a',
			latestRevisionId: 555,
		});
	});

	it('looks the property datatype up before building the snak', async () => {
		const { mock, ctx } = contextWith('wikibase-item');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'Q5' }),
			ctx,
		);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'wbgetentities',
			ids: 'P31',
			props: 'datatype',
		});
	});

	it('sends a string value as a JSON string', async () => {
		const { ctx, submit } = contextWith('string');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'hello' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ value: '"hello"' });
	});

	it('sends an external-id value as a JSON string', async () => {
		const { ctx, submit } = contextWith('external-id');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: '90196888' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ value: '"90196888"' });
	});

	it('sends a url value as a JSON string', async () => {
		const { ctx, submit } = contextWith('url');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, {
				entityId: 'Q42',
				propertyId: 'P31',
				value: 'https://example.org',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ value: '"https://example.org"' });
	});

	it('refuses a datatype it cannot build, naming it and the general write tool', async () => {
		const { ctx, submit } = contextWith('time');

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: '1952' }),
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('time');
		expect(envelope.message).toContain('wikibase-edit-entity');
		expect(submit).not.toHaveBeenCalled();
	});

	it('refuses a non-item value for an item-typed property', async () => {
		const { ctx, submit } = contextWith('wikibase-item');

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'human' }),
			ctx,
		);

		assertStructuredError(result, 'invalid_input');
		expect(submit).not.toHaveBeenCalled();
	});

	it('reports an unknown property as not_found', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ entities: { P999: { id: 'P999', missing: '' } } }),
		});
		const ctx = contextOn(mock, { edit: { ...baseEdit } });

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P999', value: 'Q5' }),
			ctx,
		);

		expect(assertStructuredError(result, 'not_found').message).toContain('P999');
	});

	it('reports a property definition without a datatype as upstream_failure', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ entities: { P31: { id: 'P31', type: 'property' } } }),
		});
		const submit = vi.fn();
		const ctx = contextOn(mock, { edit: { ...baseEdit, submit } });

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'Q5' }),
			ctx,
		);

		assertStructuredError(result, 'upstream_failure');
		expect(submit).not.toHaveBeenCalled();
	});

	it('reports a write that returned no statement as upstream_failure', async () => {
		const { ctx } = contextWith('string', vi.fn().mockResolvedValue({ success: 1 }));

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'hello' }),
			ctx,
		);

		assertStructuredError(result, 'upstream_failure');
	});

	it('refuses a property ID where an item ID belongs', async () => {
		const { ctx, submit } = contextWith('wikibase-item');

		const result = await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'P279' }),
			ctx,
		);

		assertStructuredError(result, 'invalid_input');
		expect(submit).not.toHaveBeenCalled();
	});

	it('attributes the edit to the tool that made it, after the caller comment', async () => {
		const { ctx, submit } = contextWith('string');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, {
				entityId: 'Q42',
				propertyId: 'P31',
				value: 'hello',
				comment: 'from a source',
			}),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			summary: 'from a source (via wikibase-add-statement on MediaWiki MCP Server)',
		});
	});

	it('attributes an edit the caller gave no comment for', async () => {
		const { ctx, submit } = contextWith('string');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'Q42', propertyId: 'P31', value: 'hello' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({
			summary: 'Automated edit (via wikibase-add-statement on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { ctx, submit } = contextWith('string');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, {
				entityId: 'Q42',
				propertyId: 'P31',
				value: 'hello',
				comment: 'from a source',
			}),
			withoutEditAttribution(ctx),
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ summary: 'from a source' });
	});

	it('adds a statement to a lexeme, which serialises its statements under claims', async () => {
		const { ctx, submit } = contextWith('wikibase-item');

		await wikibaseAddStatement.handle(
			toolArgs(wikibaseAddStatement, { entityId: 'L1', propertyId: 'P31', value: 'Q5' }),
			ctx,
		);

		expect(submit.mock.calls[0][1]).toMatchObject({ action: 'wbcreateclaim', entity: 'L1' });
	});

	it('rejects a MediaInfo id, naming the entity types it can write to', () => {
		expect(() =>
			toolArgs(wikibaseAddStatement, {
				entityId: 'M12017177',
				propertyId: 'P31',
				value: 'Q515',
			}),
		).toThrow(/Item, property or lexeme ID/);
	});

	it('is annotated as a write tool so the read-only gate covers it', () => {
		expect(wikibaseAddStatement.annotations.readOnlyHint).toBe(false);
	});

	describe('bot flag', () => {
		const ARGS = { entityId: 'Q42', propertyId: 'P31', value: 'Q5' };

		// botRight is stubbed per test. fakeContext's own version throws, so a call
		// that never asks for the flag also proves it never probes the account's rights.
		function contextWithRights(botRight = vi.fn().mockResolvedValue(true)) {
			const { ctx, submit } = contextWith('wikibase-item');
			return { ctx: { ...ctx, edit: { ...ctx.edit, botRight } }, submit, botRight };
		}

		it('sends no bot parameter and does not probe the rights by default', async () => {
			const { ctx, submit, botRight } = contextWithRights();

			const result = await wikibaseAddStatement.handle(toolArgs(wikibaseAddStatement, ARGS), ctx);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
			expect(assertStructuredData(result)).not.toHaveProperty('botMarked');
		});

		it('passes bot through and reports botMarked true when the account has the right', async () => {
			const { ctx, submit } = contextWithRights();

			const result = await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, { ...ARGS, bot: true }),
				ctx,
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ action: 'wbcreateclaim', bot: true });
			expect(assertStructuredData(result)).toMatchObject({ botMarked: true });
		});

		// MediaWiki saves the edit without the flag when the account lacks the right,
		// so the response is the only place that says the flag did not apply.
		it('reports botMarked false when the account lacks the bot right', async () => {
			const { ctx } = contextWithRights(vi.fn().mockResolvedValue(false));

			const result = await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, { ...ARGS, bot: true }),
				ctx,
			);

			expect(assertStructuredData(result)).toMatchObject({ botMarked: false });
		});

		it('omits botMarked, and still saves, when the rights probe fails', async () => {
			const { ctx } = contextWithRights(vi.fn().mockResolvedValue(undefined));

			const result = await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, { ...ARGS, bot: true }),
				ctx,
			);

			// The key is present with no value, and JSON serialisation drops it, as for
			// the page tools, so the caller sees no botMarked at all.
			const data = assertStructuredData(result);
			expect(data).toMatchObject({ statementId: 'Q42$8f1a' });
			expect(data.botMarked).toBeUndefined();
		});

		it('treats bot=false like an unflagged edit', async () => {
			const { ctx, submit, botRight } = contextWithRights();

			await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, { ...ARGS, bot: false }),
				ctx,
			);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
		});

		it('flags the edit when the wiki is configured to, without the call asking', async () => {
			const { ctx, submit } = contextWithRights();

			const result = await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, ARGS),
				withWikiConfig(ctx, { bot: true }),
			);

			expect(submit.mock.calls[0][1]).toMatchObject({ bot: true });
			expect(assertStructuredData(result)).toMatchObject({ botMarked: true });
		});

		it('lets a call opt out of a wiki that flags every edit', async () => {
			const { ctx, submit, botRight } = contextWithRights();

			await wikibaseAddStatement.handle(
				toolArgs(wikibaseAddStatement, { ...ARGS, bot: false }),
				withWikiConfig(ctx, { bot: true }),
			);

			expect(submit.mock.calls[0][1]).not.toHaveProperty('bot');
			expect(botRight).not.toHaveBeenCalled();
		});
	});
});
