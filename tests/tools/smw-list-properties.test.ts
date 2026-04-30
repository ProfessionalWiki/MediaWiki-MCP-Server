import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { smwListProperties } from '../../src/tools/smw-list-properties.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

interface SmwBrowsePropertyMock {
	label: string;
	key: string;
	description?: Record<string, string>;
	prefLabel?: Record<string, string>;
	usageCount?: string;
}

function smwBrowseProp(
	key: string,
	opts: { label?: string; description?: string; usageCount?: number } = {},
): [string, SmwBrowsePropertyMock] {
	const entry: SmwBrowsePropertyMock = {
		label: opts.label ?? key.replaceAll('_', ' '),
		key,
		description: { en: opts.description ?? '' },
		prefLabel: { en: '' },
	};
	if (opts.usageCount !== undefined) {
		entry.usageCount = String(opts.usageCount);
	}
	return [key, entry];
}

function smwBrowseResponse(
	entries: [string, SmwBrowsePropertyMock][],
	continueOffset: number = 0,
): unknown {
	return {
		query: Object.fromEntries(entries),
		'query-continue-offset': continueOffset,
		meta: { type: 'property', limit: entries.length, count: entries.length },
	};
}

describe('smw-list-properties', () => {
	it('calls action=smwbrowse with browse=property and returns shaped property records', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue(
					smwBrowseResponse([
						smwBrowseProp('Born_in', { description: 'Year of birth', usageCount: 1483 }),
						smwBrowseProp('Has_occupation', { usageCount: 42 }),
					]),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Name: Born in');
		expect(text).toContain('Description: Year of birth');
		expect(text).toContain('Usage count: 1483');
		expect(text).toContain('Usage: [[Born in::value]]');

		expect(text).toContain('Name: Has occupation');
		expect(text).toContain('Usage count: 42');
		expect(text).toContain('Usage: [[Has occupation::value]]');

		const sent = mock.request.mock.calls[0][0];
		expect(sent.action).toBe('smwbrowse');
		expect(sent.browse).toBe('property');
		expect(typeof sent.params).toBe('string');
		const sentParams = JSON.parse(sent.params as string);
		expect(sentParams).toMatchObject({
			search: '',
			description: true,
			prefLabel: true,
			usageCount: true,
		});
	});

	it('omits description when the en value is empty', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue(smwBrowseResponse([smwBrowseProp('Bare_property', { usageCount: 0 })])),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: Record<string, unknown>[] })
			.properties;
		expect(props[0]).toMatchObject({
			name: 'Bare property',
			usage: '[[Bare property::value]]',
			usageCount: 0,
		});
		expect(props[0]).not.toHaveProperty('description');
	});

	it('omits usageCount when smwbrowse does not return it', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse([smwBrowseProp('Some_property')])),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: Record<string, unknown>[] })
			.properties;
		expect(props[0]).toHaveProperty('name', 'Some property');
		expect(props[0]).not.toHaveProperty('usageCount');
	});

	it('parses usageCount returned as a string into a number', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockResolvedValue(
					smwBrowseResponse([smwBrowseProp('Manufacturer', { usageCount: 6190 })]),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: { usageCount: unknown }[] })
			.properties;
		expect(props[0].usageCount).toBe(6190);
	});

	it('replaces underscores with spaces when the label is missing', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					Some_internal_key: { key: 'Some_internal_key' },
				},
				'query-continue-offset': 0,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: { name: string }[] }).properties;
		expect(props[0].name).toBe('Some internal key');
	});

	it('forwards the search term to smwbrowse params', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse([])),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwListProperties.handle({ search: 'manufacturer' }, ctx);

		const sentParams = JSON.parse(mock.request.mock.calls[0][0].params as string);
		expect(sentParams.search).toBe('manufacturer');
	});

	it('forwards limit and offset to smwbrowse params', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse([])),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwListProperties.handle({ limit: 25, continueFrom: '100' }, ctx);

		const sentParams = JSON.parse(mock.request.mock.calls[0][0].params as string);
		expect(sentParams.limit).toBe(25);
		expect(sentParams.offset).toBe(100);
	});

	it('defaults limit to 50 and offset to 0 when not supplied', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse([])),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await smwListProperties.handle({}, ctx);

		const sentParams = JSON.parse(mock.request.mock.calls[0][0].params as string);
		expect(sentParams.limit).toBe(50);
		expect(sentParams.offset).toBe(0);
	});

	it('attaches a more-available truncation when query-continue-offset > 0', async () => {
		const entries = Array.from({ length: 50 }, (_, i) =>
			smwBrowseProp(`prop-${String(i).padStart(3, '0')}`),
		);
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse(entries, 50)),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({ limit: 50 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('Reason: more-available');
		expect(text).toContain('Param: continueFrom');
		expect(text).toContain('Value: 50');
	});

	it('omits truncation when query-continue-offset is 0', async () => {
		const entries = Array.from({ length: 50 }, (_, i) =>
			smwBrowseProp(`prop-${String(i).padStart(3, '0')}`),
		);
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(smwBrowseResponse(entries, 0)),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({ limit: 50 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
	});

	it('returns empty properties array when smwbrowse responds with query: []', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: [],
				'query-continue-offset': 0,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({ search: 'no-match-anywhere' }, ctx);

		expect(result.structuredContent).toMatchObject({ properties: [] });
	});

	it('falls back to a non-en description when en is empty but another lang is set', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					Foo: {
						label: 'Foo',
						key: 'Foo',
						description: { en: '', de: 'Eine Beschreibung' },
					},
				},
				'query-continue-offset': 0,
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: { description?: string }[] })
			.properties;
		expect(props[0].description).toBe('Eine Beschreibung');
	});

	it('surfaces upstream errors as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('smwbrowse 500')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(smwListProperties, ctx)({});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('smwbrowse 500');
	});
});
