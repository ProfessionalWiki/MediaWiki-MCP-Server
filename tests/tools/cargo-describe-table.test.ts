import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { cargoDescribeTable } from '../../src/tools/cargo-describe-table.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('cargo-describe-table', () => {
	it('forwards table to action=cargofields and normalizes the response', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargofields: {
					name: { type: 'String' },
					drop_level: { type: 'Integer' },
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoDescribeTable.handle({ table: 'items' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('name');
		expect(text).toContain('drop_level');

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows mock call args
		const call = mock.request.mock.calls[0][0] as Record<string, unknown>;
		expect(call.action).toBe('cargofields');
		expect(call.table).toBe('items');
		expect(call.format).toBe('json');

		expect(result.structuredContent).toMatchObject({
			fields: [
				{ name: 'name', type: 'String' },
				{ name: 'drop_level', type: 'Integer' },
			],
		});
	});

	it('marks list fields with isList: true and surfaces delimiter', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargofields: {
					drop_areas: { type: 'String', isList: '', delimiter: ',' },
					name: { type: 'String' },
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoDescribeTable.handle({ table: 'items' }, ctx);

		expect(result.structuredContent).toMatchObject({
			fields: [
				{ name: 'drop_areas', type: 'String', isList: true, delimiter: ',' },
				{ name: 'name', type: 'String' },
			],
		});
	});

	it('omits isList and delimiter for non-list fields', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargofields: { name: { type: 'String' } },
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoDescribeTable.handle({ table: 'items' }, ctx);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test, narrows structuredContent
		const sc = result.structuredContent as { fields: Array<Record<string, unknown>> };
		expect(sc.fields[0]).toEqual({ name: 'name', type: 'String' });
		expect('isList' in sc.fields[0]).toBe(false);
		expect('delimiter' in sc.fields[0]).toBe(false);
	});

	it('passes Cargo type strings through verbatim without validation', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				cargofields: {
					loc: { type: 'Coordinates' },
					body: { type: 'Searchtext' },
					future_type: { type: 'SomeNewType' },
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await cargoDescribeTable.handle({ table: 'items' }, ctx);

		expect(result.structuredContent).toMatchObject({
			fields: [
				{ name: 'loc', type: 'Coordinates' },
				{ name: 'body', type: 'Searchtext' },
				{ name: 'future_type', type: 'SomeNewType' },
			],
		});
	});

	it('returns fields: [] when cargofields is missing or empty', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ cargofields: {} }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const r1 = await cargoDescribeTable.handle({ table: 'items' }, ctx);
		expect(r1.structuredContent).toMatchObject({ fields: [] });

		const r2 = await cargoDescribeTable.handle({ table: 'items' }, ctx);
		expect(r2.structuredContent).toMatchObject({ fields: [] });
	});

	it('remaps internal_api_error_MWException to invalid_input with "Table not found" hint', async () => {
		const mock = createMockMwn({
			request: vi
				.fn()
				.mockRejectedValue(
					createMockMwnError(
						'internal_api_error_MWException',
						'[reqid-abc] Caught exception of type MWException',
					),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoDescribeTable, ctx)({ table: 'nonexistent' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toBe(
			'Table not found. Use cargo-list-tables to see available table names.',
		);
		expect(envelope.code).toBe('internal_api_error_MWException');
	});

	it('surfaces network failures as upstream_failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('cargofields network failure')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(cargoDescribeTable, ctx)({ table: 'items' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('cargofields network failure');
	});

	it('rejects an empty table parameter at the schema layer', () => {
		// zod validation runs in the dispatcher before reaching handle()
		// — this is asserted indirectly by the schema definition; explicit
		// dispatcher-level rejection is covered by dispatcher.test.ts.
		expect(cargoDescribeTable.inputSchema.table.safeParse('').success).toBe(false);
		expect(cargoDescribeTable.inputSchema.table.safeParse('items').success).toBe(true);
	});
});
