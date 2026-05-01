import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.js';
import { fakeContext } from '../../../helpers/fakeContext.js';
import { cargoListTables } from '../../../../src/tools/extensions/cargo/cargo-list-tables.js';
import { dispatch } from '../../../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess,
} from '../../../helpers/structuredResult.js';

describe('cargo-list-tables', () => {
	it('forwards to action=cargotables and returns the tables array', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargotables: ['items', 'skill_levels', '_pageData'],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoListTables.handle({}, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('items');
		expect(text).toContain('_pageData');

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.action).toBe('cargotables');
		expect(call.format).toBe('json');

		expect(result.structuredContent).toMatchObject({
			tables: ['items', 'skill_levels', '_pageData'],
		});
	});

	it('passes underscore-prefixed system tables through unfiltered', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargotables: ['_pageData', '_fileData', 'items'],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoListTables.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({
			tables: ['_pageData', '_fileData', 'items'],
		});
	});

	it('drops non-string entries from cargotables defensively', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargotables: ['items', null, 42, { name: 'malformed' }, '_pageData'],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoListTables.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({
			tables: ['items', '_pageData'],
		});
	});

	it('returns tables: [] when cargotables is missing', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoListTables.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({ tables: [] });
	});

	it('returns tables: [] when cargotables is empty', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargotables: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoListTables.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({ tables: [] });
	});

	it('surfaces upstream errors as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('cargotables network failure')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoListTables, ctx)({});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('cargotables network failure');
	});
});
