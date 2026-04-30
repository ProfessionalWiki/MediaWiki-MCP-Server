import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { smwListProperties } from '../../src/tools/smw-list-properties.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('smw-list-properties', () => {
	it('calls action=smwbrowse&browse=property and returns shaped property records', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: [
					{ label: 'Born in', type: '_dat', description: 'Year of birth', usageCount: 1483 },
					{ label: 'Has occupation', type: '_wpg' },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Name: Born in');
		expect(text).toContain('Type: Date');
		expect(text).toContain('Description: Year of birth');
		expect(text).toContain('Usage count: 1483');
		expect(text).toContain('Usage: [[Born in::value]]');

		expect(text).toContain('Name: Has occupation');
		expect(text).toContain('Type: Page');
		expect(text).toContain('Usage: [[Has occupation::value]]');

		expect(mock.request.mock.calls[0][0]).toMatchObject({
			action: 'smwbrowse',
			browse: 'property',
		});
	});

	it('omits description and usageCount when unavailable', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: [{ label: 'Bare property', type: '_txt' }],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: Record<string, unknown>[] })
			.properties;
		expect(props[0]).toHaveProperty('name', 'Bare property');
		expect(props[0]).toHaveProperty('type', 'Text');
		expect(props[0]).toHaveProperty('usage', '[[Bare property::value]]');
		expect(props[0]).not.toHaveProperty('description');
		expect(props[0]).not.toHaveProperty('usageCount');
	});

	it('filters by case-insensitive substring on search', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: [
					{ label: 'Born in', type: '_dat' },
					{ label: 'Birth date', type: '_dat' },
					{ label: 'Has occupation', type: '_wpg' },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({ search: 'BORN' }, ctx);

		const props = (result.structuredContent as { properties: { name: string }[] }).properties;
		expect(props.map((p) => p.name)).toEqual(['Born in']);
	});

	it('sorts results alphabetically by name (case-insensitive)', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: [
					{ label: 'zebra', type: '_txt' },
					{ label: 'Apple', type: '_txt' },
					{ label: 'banana', type: '_txt' },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		const props = (result.structuredContent as { properties: { name: string }[] }).properties;
		expect(props.map((p) => p.name)).toEqual(['Apple', 'banana', 'zebra']);
	});

	it('default limit is 50; user-provided limit is honoured', async () => {
		const labels = Array.from({ length: 75 }, (_, i) => ({
			label: `prop-${String(i).padStart(3, '0')}`,
			type: '_txt',
		}));
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: labels }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const resultDefault = await smwListProperties.handle({}, ctx);
		const propsDefault = (resultDefault.structuredContent as { properties: unknown[] }).properties;
		expect(propsDefault).toHaveLength(50);

		const resultLimit = await smwListProperties.handle({ limit: 10 }, ctx);
		const propsLimit = (resultLimit.structuredContent as { properties: unknown[] }).properties;
		expect(propsLimit).toHaveLength(10);
	});

	it('attaches a more-available truncation when results exceed the limit', async () => {
		const labels = Array.from({ length: 75 }, (_, i) => ({
			label: `prop-${String(i).padStart(3, '0')}`,
			type: '_txt',
		}));
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: labels }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({ limit: 50 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('Reason: more-available');
		expect(text).toContain('Param: continueFrom');
		expect(text).toMatch(/Value: 50/);
	});

	it('returns empty properties array on no results', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await smwListProperties.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({ properties: [] });
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
