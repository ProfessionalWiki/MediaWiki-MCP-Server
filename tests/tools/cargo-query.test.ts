import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { cargoQuery } from '../../src/tools/cargo-query.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('cargo-query', () => {
	it('forwards tables and optional params to action=cargoquery and unwraps rows', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargoquery: [
					{ title: { name: 'Abyssal whip', drop_level: '85' } },
					{ title: { name: 'Dragon bones', drop_level: '1' } },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle(
			{
				tables: 'items',
				fields: 'name,drop_level',
				where: 'drop_level > 50',
				orderBy: 'drop_level DESC',
				limit: 10,
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Abyssal whip');
		expect(text).toContain('Dragon bones');

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.action).toBe('cargoquery');
		expect(call.tables).toBe('items');
		expect(call.fields).toBe('name,drop_level');
		expect(call.where).toBe('drop_level > 50');
		expect(call.order_by).toBe('drop_level DESC');
		expect(call.limit).toBe(10);
		expect(call.format).toBe('json');

		expect(result.structuredContent).toMatchObject({
			rows: [
				{ name: 'Abyssal whip', drop_level: '85' },
				{ name: 'Dragon bones', drop_level: '1' },
			],
		});
	});

	it('unwraps the title key from each entry', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargoquery: [{ title: { _pageName: 'Monster', xp: '42' } }],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'combat' }, ctx);

		expect(result.structuredContent).toMatchObject({
			rows: [{ _pageName: 'Monster', xp: '42' }],
		});
	});

	it('returns rows: [] when cargoquery is missing', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items' }, ctx);

		expect(result.structuredContent).toMatchObject({ rows: [] });
	});

	it('returns rows: [] when cargoquery is an empty array', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items' }, ctx);

		expect(result.structuredContent).toMatchObject({ rows: [] });
	});

	it('uses default limit of 500 when caller omits limit', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await cargoQuery.handle({ tables: 'items' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.limit).toBe(500);
	});

	it('forwards caller-supplied limit verbatim within range', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await cargoQuery.handle({ tables: 'items', limit: 42 }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.limit).toBe(42);
	});

	it('rejects limit > 500 at the schema layer', () => {
		expect(cargoQuery.inputSchema.limit.safeParse(501).success).toBe(false);
		expect(cargoQuery.inputSchema.limit.safeParse(500).success).toBe(true);
	});

	it('sets offset when continueFrom is provided', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await cargoQuery.handle({ tables: 'items', continueFrom: '100' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.offset).toBe(100);
	});

	it('rejects non-integer continueFrom with invalid_input', async () => {
		const mock = createMockMwn({ request: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(
			cargoQuery,
			ctx,
		)({ tables: 'items', continueFrom: 'not-a-number' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toBe('continueFrom must be a non-negative integer');
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('rejects negative continueFrom with invalid_input', async () => {
		const mock = createMockMwn({ request: vi.fn() });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoQuery, ctx)({ tables: 'items', continueFrom: '-1' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toBe('continueFrom must be a non-negative integer');
		expect(mock.request).not.toHaveBeenCalled();
	});

	it('emits more-available truncation when rows.length === effectiveLimit', async () => {
		const fullPage = Array.from({ length: 50 }, (_, i) => ({
			title: { name: `Item ${i}` },
		}));
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: fullPage }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items', limit: 50 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Truncation:');
		expect(text).toContain('Reason: more-available');
		expect(text).toContain('Param: continueFrom');
		expect(text).toContain('Value: 50');
	});

	it('continueWith.value advances by rows.length on subsequent pages', async () => {
		const fullPage = Array.from({ length: 50 }, (_, i) => ({
			title: { name: `Item ${i + 50}` },
		}));
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: fullPage }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items', limit: 50, continueFrom: '50' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Value: 100');
	});

	it('emits no truncation when rows.length < effectiveLimit', async () => {
		const partial = Array.from({ length: 3 }, (_, i) => ({
			title: { name: `Item ${i}` },
		}));
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: partial }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items', limit: 50 }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).not.toContain('Truncation:');
	});

	it('forwards field aliases with spaces verbatim', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargoquery: [{ title: { 'Item Name': 'Abyssal whip' } }],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoQuery.handle({ tables: 'items', fields: 'name=Item Name' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.fields).toBe('name=Item Name');

		expect(result.structuredContent).toMatchObject({
			rows: [{ 'Item Name': 'Abyssal whip' }],
		});
	});

	it('remaps internal_api_error_MWException to invalid_input with Cargo parse hint', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockRejectedValue(
					createMockMwnError(
						'internal_api_error_MWException',
						'[reqid-xyz] Caught exception of type MWException',
					),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoQuery, ctx)({ tables: 'nonexistent' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toBe(
			'Cargo could not parse the query. Verify table and field names with cargo-list-tables / cargo-describe-table, or inspect Special:CargoTables.',
		);
		expect(envelope.code).toBe('internal_api_error_MWException');
	});

	it('surfaces network failures as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('cargoquery network failure')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoQuery, ctx)({ tables: 'items' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('cargoquery network failure');
	});

	it('drops undefined optional params from the request payload', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ cargoquery: [] }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await cargoQuery.handle({ tables: 'items' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect('fields' in call).toBe(false);
		expect('where' in call).toBe(false);
		expect('join_on' in call).toBe(false);
		expect('group_by' in call).toBe(false);
		expect('having' in call).toBe(false);
		expect('order_by' in call).toBe(false);
	});
});
