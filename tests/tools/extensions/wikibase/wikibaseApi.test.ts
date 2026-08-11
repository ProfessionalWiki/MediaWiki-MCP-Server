import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import {
	fetchLabels,
	LABEL_CALL_SIZE,
	labelOf,
	LANGUAGE_CODE,
	languageRecognised,
	MAX_LABEL_IDS,
} from '../../../../src/tools/extensions/wikibase/wikibaseApi.ts';

const LABEL_LANGUAGE = 'en';

describe('LANGUAGE_CODE', () => {
	it('accepts a code carrying digits', () => {
		// es-419 is Latin American Spanish, a language code Wikidata uses.
		expect(LANGUAGE_CODE.test('es-419')).toBe(true);
	});

	it('accepts a plain and a regional code', () => {
		expect(LANGUAGE_CODE.test('en')).toBe(true);
		expect(LANGUAGE_CODE.test('pt-br')).toBe(true);
	});

	it('rejects a pipe-separated list', () => {
		expect(LANGUAGE_CODE.test('en|de|fr')).toBe(false);
	});

	it('rejects a code that starts with a digit', () => {
		expect(LANGUAGE_CODE.test('419')).toBe(false);
	});

	// MediaWiki codes are lowercase, and the API answers an unrecognised one with
	// every language the entity has rather than an error, so the case a caller is
	// most likely to guess wrong is worth refusing before the request goes out.
	it('rejects an uppercased code, which the wiki does not recognise', () => {
		expect(LANGUAGE_CODE.test('en-US')).toBe(false);
		expect(LANGUAGE_CODE.test('EN')).toBe(false);
	});
});

describe('labelOf', () => {
	it('returns the label in the requested language', () => {
		const entity = {
			labels: { en: { value: 'human' }, de: { value: 'Mensch' } },
		};

		expect(labelOf(entity, 'de')).toBe('Mensch');
	});

	// A recognised code is answered with the terms of its own fallback chain, so a
	// term keyed under another language is not this entity's name in the language
	// that was asked for.
	it('returns undefined when the label is in another language', () => {
		const entity = { labels: { de: { value: 'Mensch' } } };

		expect(labelOf(entity, 'en')).toBeUndefined();
	});

	it('returns undefined for an entity with no labels at all', () => {
		expect(labelOf({ labels: {} }, 'en')).toBeUndefined();
		expect(labelOf({}, 'en')).toBeUndefined();
		expect(labelOf(undefined, 'en')).toBeUndefined();
	});
});

describe('languageRecognised', () => {
	it('accepts a code the wiki answered under the key that was asked for', () => {
		expect(languageRecognised([{ en: { value: 'Douglas Adams' } }], 'en')).toBe(true);
	});

	it('rejects a code the wiki answered with every language the entity has', () => {
		const labels = { ar: { value: 'دوغلاس آدمز' }, de: { value: 'Douglas Adams' } };

		expect(languageRecognised([labels], 'en')).toBe(false);
	});

	it('accepts a code no term of the entity resolved to', () => {
		expect(languageRecognised([{}, {}], 'en')).toBe(true);
	});

	it('rejects a code that any one term map answered with other languages', () => {
		const maps = [{ en: { value: 'Douglas Adams' } }, {}, { de: [{ value: 'Adams' }] }];

		expect(languageRecognised(maps, 'en')).toBe(false);
	});

	it('accepts a code where the response carries no term map at all', () => {
		expect(languageRecognised([undefined, undefined], 'en')).toBe(true);
	});

	// A code naming a member of Object's prototype reads back as an inherited
	// value rather than as a term the wiki returned.
	it('rejects a code that only names an inherited member', () => {
		expect(languageRecognised([{ de: { value: 'Mensch' } }], 'constructor')).toBe(false);
	});
});

function labelResponse(ids: readonly string[]): { entities: Record<string, unknown> } {
	const entities: Record<string, unknown> = {};
	for (const id of ids) {
		entities[id] = { id, labels: { en: { language: 'en', value: `label of ${id}` } } };
	}
	return { entities };
}

function ids(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `Q${i + 1}`);
}

describe('fetchLabels', () => {
	it('resolves labels across the batches the wiki accepts', async () => {
		const mock = createMockMwn({
			request: vi.fn((params: Record<string, unknown>) =>
				Promise.resolve(labelResponse(String(params.ids).split('|'))),
			),
		});

		const labels = await fetchLabels(mock as never, ids(LABEL_CALL_SIZE + 1), LABEL_LANGUAGE);

		expect(mock.request).toHaveBeenCalledTimes(2);
		expect(labels.size).toBe(LABEL_CALL_SIZE + 1);
	});

	it('keeps the labels of the batches that succeeded when one fails', async () => {
		let call = 0;
		const mock = createMockMwn({
			request: vi.fn((params: Record<string, unknown>) => {
				call += 1;
				return call === 1
					? Promise.reject(new Error('HTTP 429'))
					: Promise.resolve(labelResponse(String(params.ids).split('|')));
			}),
		});

		const labels = await fetchLabels(mock as never, ids(LABEL_CALL_SIZE + 2), LABEL_LANGUAGE);

		expect(labels.size).toBe(2);
		expect(labels.get(`Q${LABEL_CALL_SIZE + 1}`)).toBe(`label of Q${LABEL_CALL_SIZE + 1}`);
	});

	it('reports each failed batch to the caller', async () => {
		const mock = createMockMwn({ request: vi.fn().mockRejectedValue(new Error('HTTP 429')) });
		const failures: unknown[] = [];

		const labels = await fetchLabels(
			mock as never,
			ids(LABEL_CALL_SIZE + 1),
			LABEL_LANGUAGE,
			(err) => failures.push(err),
		);

		expect(failures).toHaveLength(2);
		expect(labels.size).toBe(0);
	});

	it('stops at the lookup budget however many ids it is given', async () => {
		const mock = createMockMwn({
			request: vi.fn((params: Record<string, unknown>) =>
				Promise.resolve(labelResponse(String(params.ids).split('|'))),
			),
		});

		const labels = await fetchLabels(mock as never, ids(MAX_LABEL_IDS + 50), LABEL_LANGUAGE);

		expect(labels.size).toBe(MAX_LABEL_IDS);
	});
});
