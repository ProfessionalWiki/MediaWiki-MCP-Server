import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext } from '../../../helpers/fakeContext.ts';
import { toolArgs } from '../../../helpers/toolArgs.ts';
import { wikibaseGetEntity } from '../../../../src/tools/extensions/wikibase/wikibase-get-entity.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';
import {
	assertStructuredData,
	assertStructuredError,
	assertStructuredSuccess,
} from '../../../helpers/structuredResult.ts';

function itemSnak(property: string, id: string) {
	return {
		snaktype: 'value',
		property,
		datatype: 'wikibase-item',
		datavalue: { value: { 'entity-type': 'item', id }, type: 'wikibase-entityid' },
	};
}

const Q42 = {
	entities: {
		Q42: {
			type: 'item',
			id: 'Q42',
			labels: { en: { language: 'en', value: 'Douglas Adams' } },
			descriptions: { en: { language: 'en', value: 'British science fiction writer' } },
			aliases: { en: [{ language: 'en', value: 'Douglas Noel Adams' }] },
			claims: {
				P31: [{ mainsnak: itemSnak('P31', 'Q5'), rank: 'normal' }],
				P106: [{ mainsnak: itemSnak('P106', 'Q36834'), rank: 'normal' }],
			},
		},
	},
};

const LABELS = {
	entities: {
		P31: { id: 'P31', labels: { en: { language: 'en', value: 'instance of' } } },
		P106: { id: 'P106', labels: { en: { language: 'en', value: 'occupation' } } },
		Q5: { id: 'Q5', labels: { en: { language: 'en', value: 'human' } } },
		Q36834: { id: 'Q36834', labels: { en: { language: 'en', value: 'composer' } } },
	},
};

// Routes the entity read and the label batch to separate canned responses, so a
// test can assert what each call asked for without ordering assumptions.
function routedMwn(entityResponse: unknown, labelResponse: unknown = LABELS) {
	return createMockMwn({
		request: vi.fn((params: Record<string, unknown>) =>
			Promise.resolve(params.props === 'labels' ? labelResponse : entityResponse),
		),
	});
}

function labelCalls(mock: ReturnType<typeof createMockMwn>): Record<string, unknown>[] {
	return mock.request.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter((params) => params.props === 'labels');
}

function requestedLabelIds(mock: ReturnType<typeof createMockMwn>): string[][] {
	return labelCalls(mock).map((params) => String(params.ids).split('|'));
}

describe('wikibase-get-entity', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('renders a header and one statement line per property', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Douglas Adams');
		expect(text).toContain('British science fiction writer');
		expect(text).toContain('Douglas Noel Adams');
		expect(text).toContain('P31 (instance of): Q5 (human)');
		expect(text).toContain('P106 (occupation): Q36834 (composer)');
	});

	it('resolves every referenced property and item label in one batched follow-up', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await wikibaseGetEntity.handle(toolArgs(wikibaseGetEntity, { entityId: 'Q42' }), ctx);

		expect(mock.request).toHaveBeenCalledTimes(2);
		expect(requestedLabelIds(mock)[0].sort()).toEqual(['P106', 'P31', 'Q36834', 'Q5']);
	});

	it('does not issue a label call for an entity with no statements', async () => {
		const mock = routedMwn({
			entities: {
				Q1: { type: 'item', id: 'Q1', labels: { en: { language: 'en', value: 'Universe' } } },
			},
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q1' }),
			ctx,
		);

		expect(mock.request).toHaveBeenCalledTimes(1);
		expect(assertStructuredData(result).statements).toEqual([]);
	});

	it('reports a property entity datatype in the header', async () => {
		const mock = routedMwn({
			entities: {
				P31: {
					type: 'property',
					id: 'P31',
					datatype: 'wikibase-item',
					labels: { en: { language: 'en', value: 'instance of' } },
				},
			},
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'P31' }),
			ctx,
		);

		expect(assertStructuredData(result).datatype).toBe('wikibase-item');
	});

	it('renders only the requested property when property is set', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42', property: 'P106' }),
			ctx,
		);

		const statements = assertStructuredData(result).statements as string[];
		expect(statements).toEqual(['P106 (occupation): Q36834 (composer)']);
		expect(requestedLabelIds(mock)[0].sort()).toEqual(['P106', 'Q36834']);
	});

	it('accepts a lowercase property filter', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42', property: 'p106' }),
			ctx,
		);

		expect(assertStructuredData(result).statements).toEqual([
			'P106 (occupation): Q36834 (composer)',
		]);
	});

	it('requests every entity field the rendering reads', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await wikibaseGetEntity.handle(toolArgs(wikibaseGetEntity, { entityId: 'Q42' }), ctx);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			props: 'labels|descriptions|aliases|claims|datatype',
			languages: 'en',
			languagefallback: 1,
			formatversion: '2',
		});
	});

	it('requests the entity in the wiki content language with fallback', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });
		ctx.siteInfoCache.set('test-wiki', {
			server: 'https://test.wiki',
			articlepath: '/wiki',
			lang: 'de',
		});

		await wikibaseGetEntity.handle(toolArgs(wikibaseGetEntity, { entityId: 'Q42' }), ctx);

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'wbgetentities',
			ids: 'Q42',
			languages: 'de',
			languagefallback: 1,
		});
	});

	it('reports a missing entity as not_found', async () => {
		const mock = routedMwn({ entities: { Q999: { id: 'Q999', missing: '' } } });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q999' }),
			ctx,
		);

		expect(assertStructuredError(result, 'not_found').message).toContain('Q999');
	});

	it('returns an empty statement list for a property the entity does not use', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42', property: 'P999' }),
			ctx,
		);

		expect(assertStructuredData(result).statements).toEqual([]);
	});

	it('classifies a no-such-entity API error as not_found', async () => {
		const error = Object.assign(new Error('Could not find an entity with the ID "Q9".'), {
			code: 'no-such-entity',
		});
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(error) });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			wikibaseGetEntity,
			ctx,
		)(toolArgs(wikibaseGetEntity, { entityId: 'Q9' }));

		assertStructuredError(result, 'not_found');
	});

	it('caps the number of properties rendered and points at the property filter', async () => {
		const mock = routedMwn(entityWithProperties(60), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect((data.statements as string[]).length).toBe(50);
		expect(data.truncation).toMatchObject({
			reason: 'capped-no-continuation',
			limit: 50,
			itemNoun: 'properties',
		});
		expect(String(data.truncation.narrowHint)).toContain('property');
	});

	it('splits the label lookup into requests the wiki accepts', async () => {
		const mock = routedMwn(entityWithProperties(60), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		await wikibaseGetEntity.handle(toolArgs(wikibaseGetEntity, { entityId: 'Q42' }), ctx);

		// 50 rendered properties plus their 50 item values.
		expect(requestedLabelIds(mock).map((ids) => ids.length)).toEqual([50, 50]);
	});

	it('stops looking up labels past the budget and leaves those ids bare', async () => {
		const mock = routedMwn(entityWithProperties(50, 4), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		// 250 ids referenced, 150 looked up: three requests, no more.
		const requested = requestedLabelIds(mock);
		expect(requested.flat()).toHaveLength(150);
		expect(requested).toHaveLength(3);
		expect(assertStructuredData(result).statements[0]).toBe('P1: Q1001; Q2001; Q3001; Q4001');
	});

	it('drops the trailing statement when the byte cap lands inside it', async () => {
		// 85 bytes covers eight `P<n>: Q<nnnn>` lines and five characters of the ninth.
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '85');
		const mock = routedMwn(entityWithProperties(40), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		expect(assertStructuredData(result).statements).toEqual([
			'P1: Q1001',
			'P2: Q1002',
			'P3: Q1003',
			'P4: Q1004',
			'P5: Q1005',
			'P6: Q1006',
			'P7: Q1007',
			'P8: Q1008',
		]);
	});

	it('reports the entity a redirected id resolves to', async () => {
		const mock = routedMwn({
			entities: {
				Q12937355: {
					type: 'item',
					id: 'Q5',
					redirects: { from: 'Q12937355', to: 'Q5' },
					labels: { en: { language: 'en', value: 'human' } },
				},
			},
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q12937355' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.entityId).toBe('Q5');
		expect(data.redirectedFrom).toBe('Q12937355');
	});

	it('reports no redirect for an id that is its own entity', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		expect(assertStructuredData(result).redirectedFrom).toBeUndefined();
	});

	// An uppercased code is refused by the schema, so the runtime check answers
	// for the codes that are shaped like one and still name no language.
	it('refuses a language code the wiki did not recognise', async () => {
		const mock = routedMwn(everyLanguage());
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42', language: 'english' }),
			ctx,
		);

		const { message } = assertStructuredError(result, 'invalid_input');
		expect(message).toContain('english');
		expect(message).toContain('language');
	});

	it('refuses an uppercased language code before it reaches the wiki', () => {
		expect(() => toolArgs(wikibaseGetEntity, { entityId: 'Q42', language: 'en-US' })).toThrow(
			/lowercase language code/,
		);
	});

	// The response to an unrecognised code carries every language the entity has,
	// and a label batch asking for the same code multiplies that by fifty ids.
	it('spends no label lookup on a language code the wiki did not recognise', async () => {
		const mock = routedMwn(everyLanguage());
		const ctx = fakeContext({ mwn: async () => mock as never });

		await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42', language: 'english' }),
			ctx,
		);

		expect(mock.request).toHaveBeenCalledTimes(1);
	});

	it('reports no term for an entity the requested language reaches nothing of', async () => {
		const mock = routedMwn({
			entities: {
				Q93822343: { type: 'item', id: 'Q93822343', labels: {}, descriptions: {}, aliases: {} },
			},
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q93822343' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.label).toBeUndefined();
		expect(data.description).toBeUndefined();
		expect(data.aliases).toBeUndefined();
	});

	it('renders the statements of a lexeme', async () => {
		const mock = routedMwn({
			entities: {
				L1: {
					type: 'lexeme',
					id: 'L1',
					lemmas: { 'sux-latn': { language: 'sux-latn', value: 'ama' } },
					claims: { P31: [{ mainsnak: itemSnak('P31', 'Q5'), rank: 'normal' }] },
				},
			},
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'L1' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.entityId).toBe('L1');
		expect(data.statements).toEqual(['P31 (instance of): Q5 (human)']);
	});

	it('rejects a language list where one language code belongs', () => {
		expect(() => toolArgs(wikibaseGetEntity, { entityId: 'Q42', language: 'en|de|fr' })).toThrow();
	});

	it('rejects an entity id of a type it cannot read, naming the ones it can', () => {
		expect(() => toolArgs(wikibaseGetEntity, { entityId: 'M12017177' })).toThrow(
			/Item, property or lexeme ID/,
		);
	});

	it('accepts a lowercase item id', async () => {
		const mock = routedMwn(Q42);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'q42' }),
			ctx,
		);

		expect(assertStructuredData(result).entityId).toBe('Q42');
	});

	it('spends no label lookup on values the per-property cap hides', async () => {
		const mock = routedMwn(entityWithValues(45), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		await wikibaseGetEntity.handle(toolArgs(wikibaseGetEntity, { entityId: 'Q64' }), ctx);

		// The property plus the ten values that render, and nothing beyond them.
		expect(requestedLabelIds(mock)[0]).toEqual([
			'P1082',
			...Array.from({ length: 10 }, (_, i) => `Q${1000 + i}`),
		]);
	});

	it('renders every value of the filtered property, past the per-property cap', async () => {
		const mock = routedMwn(entityWithValues(45), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64', property: 'P1082' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect((data.statements as string[])[0].split('; ')).toHaveLength(45);
		expect(data.truncation).toBeUndefined();
	});

	it('caps the values of an unfiltered property and says how to read it in full', async () => {
		const mock = routedMwn(entityWithValues(45), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect((data.statements as string[])[0].split('; ')).toHaveLength(10);
		expect(data.truncation).toMatchObject({
			reason: 'capped-no-continuation',
			limit: 10,
			itemNoun: 'values',
		});
		expect(String(data.truncation.narrowHint)).toContain('P1082 shows 10 of 45 values');
		expect(String(data.truncation.narrowHint)).toContain('property=P1082');
	});

	it('names the property that lost the most values, not the first one', async () => {
		const mock = routedMwn(entityWithUnevenValues(), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64' }),
			ctx,
		);

		const hint = String(assertStructuredData(result).truncation.narrowHint);
		expect(hint).toContain('3 properties have more values than shown');
		expect(hint).toContain('the largest, P2, shows 10 of 40');
	});

	it('counts the values the whole response rendered, not one property’s', async () => {
		const mock = routedMwn(entityWithUnevenValues(), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64' }),
			ctx,
		);

		// Three properties showing ten values each.
		expect(assertStructuredData(result).truncation.returnedCount).toBe(30);
	});

	it('states the hidden values as well when the property cap fires', async () => {
		const mock = routedMwn(entityWithProperties(60, 12), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect(data.truncation).toMatchObject({ itemNoun: 'properties', limit: 50 });
		const hint = String(data.truncation.narrowHint);
		expect(hint).toContain('the entity has 60');
		expect(hint).toContain('50 properties have more values than shown');
		expect(hint).toContain('shows 10 of 12');
	});

	it('truncates the statement block at the content byte cap', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '80');
		const mock = routedMwn(entityWithProperties(40), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		const data = assertStructuredData(result);
		expect((data.statements as string[]).length).toBeLessThan(40);
		expect(data.truncation).toMatchObject({ reason: 'content-truncated', itemNoun: 'statements' });
	});

	it('names the properties the property cap dropped when the byte cap fires as well', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '80');
		const mock = routedMwn(entityWithProperties(60), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		expect(String(assertStructuredData(result).truncation.remedyHint)).toBe(
			'The entity has 60 properties; 50 were rendered before the byte cap. To read one property in full, call wikibase-get-entity again with property=<P-id>.',
		);
	});

	it('names the values the value cap hid when the byte cap fires as well', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '40');
		const mock = routedMwn(entityWithValues(45), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64' }),
			ctx,
		);

		expect(String(assertStructuredData(result).truncation.remedyHint)).toBe(
			'P1082 shows 10 of 45 values. To read one property in full, call wikibase-get-entity again with property=P1082.',
		);
	});

	it('states both count caps in one remedy when the byte cap fires as well', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '80');
		const mock = routedMwn(entityWithProperties(60, 12), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		expect(String(assertStructuredData(result).truncation.remedyHint)).toBe(
			'The entity has 60 properties; 50 were rendered before the byte cap; 50 properties have more values than shown; the largest, P1, shows 10 of 12. To read one property in full, call wikibase-get-entity again with property=<P-id>.',
		);
	});

	it('states that nothing reaches the rest when the byte cap cuts the filtered property', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '40');
		const mock = routedMwn(entityWithValues(45), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q64', property: 'p1082' }),
			ctx,
		);

		expect(String(assertStructuredData(result).truncation.remedyHint)).toBe(
			'The byte budget cut the values of P1082, and no parameter of this tool reaches the rest.',
		);
	});

	it('leaves the byte-cap remedy alone when no count cap was in play', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '80');
		const mock = routedMwn(entityWithProperties(40), { entities: {} });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await wikibaseGetEntity.handle(
			toolArgs(wikibaseGetEntity, { entityId: 'Q42' }),
			ctx,
		);

		expect(String(assertStructuredData(result).truncation.remedyHint)).toBe(
			'To read one property in full, call wikibase-get-entity again with property=<P-id>.',
		);
	});
});

// What the wiki answers when it does not recognise the languages value: a
// warning, and the terms of every language the entity has.
function everyLanguage(): unknown {
	return {
		entities: {
			Q42: {
				type: 'item',
				id: 'Q42',
				labels: {
					ar: { language: 'ar', value: 'دوغلاس آدمز' },
					en: { language: 'en', value: 'Douglas Adams' },
				},
				descriptions: {
					ar: { language: 'ar', value: 'كاتب بريطاني' },
					en: { language: 'en', value: 'British science fiction writer' },
				},
				aliases: { en: [{ language: 'en', value: 'Douglas Noel Adams' }] },
				claims: { P31: [{ mainsnak: itemSnak('P31', 'Q5'), rank: 'normal' }] },
			},
		},
	};
}

// One property carrying more values than the per-property cap shows.
function entityWithValues(count: number): unknown {
	return {
		entities: { Q64: { type: 'item', id: 'Q64', claims: { P1082: values('P1082', count) } } },
	};
}

// Three properties over the value cap, the middle one by far the most.
function entityWithUnevenValues(): unknown {
	const claims = { P1: values('P1', 12), P2: values('P2', 40), P3: values('P3', 15) };
	return { entities: { Q64: { type: 'item', id: 'Q64', claims } } };
}

function values(property: string, count: number): unknown[] {
	return Array.from({ length: count }, (_, v) => ({
		mainsnak: itemSnak(property, `Q${1000 + v}`),
		rank: 'normal',
	}));
}

function entityWithProperties(count: number, valuesEach = 1): unknown {
	const claims: Record<string, unknown[]> = {};
	for (let i = 1; i <= count; i++) {
		claims[`P${i}`] = Array.from({ length: valuesEach }, (_, v) => ({
			mainsnak: itemSnak(`P${i}`, `Q${(v + 1) * 1000 + i}`),
			rank: 'normal',
		}));
	}
	return { entities: { Q42: { type: 'item', id: 'Q42', claims } } };
}
