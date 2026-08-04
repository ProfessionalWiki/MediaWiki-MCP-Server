import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import {
	fetchLabels,
	LABEL_CALL_SIZE,
	labelOf,
	LANGUAGE_CODE,
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
});

describe('labelOf', () => {
	it('returns the label in the requested language', () => {
		const entity = {
			labels: { en: { value: 'human' }, de: { value: 'Mensch' } },
		};

		expect(labelOf(entity, 'de')).toBe('Mensch');
	});

	// A wiki that has no term in the caller's language still knows the entity by
	// some name, and a bare Q-id is what the alternative reads as.
	it('falls back to a label in another language when the requested one has none', () => {
		const entity = { labels: { de: { value: 'Mensch' } } };

		expect(labelOf(entity, 'en')).toBe('Mensch');
	});

	it('returns undefined for an entity with no labels at all', () => {
		expect(labelOf({ labels: {} }, 'en')).toBeUndefined();
		expect(labelOf({}, 'en')).toBeUndefined();
		expect(labelOf(undefined, 'en')).toBeUndefined();
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
