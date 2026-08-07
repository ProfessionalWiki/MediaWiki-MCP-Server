import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { unquoteNumber } from '../../src/runtime/numericArg.ts';

const limit = unquoteNumber(z.number().int().min(1).max(500));

// Mirrors update-page's section, the parameter where a wrongly accepted zero
// does damage, and the only one whose lower bound cannot mask a bad conversion.
const section = unquoteNumber(z.number().int().nonnegative());

function parse(value: unknown): z.ZodSafeParseResult<number> {
	return limit.safeParse(value) as z.ZodSafeParseResult<number>;
}

function accepts(value: unknown): boolean {
	return parse(value).success;
}

// The conversion the MCP SDK runs over a tool's schema to publish it: zod 4.2
// and later carry it on the schema itself, and the SDK prefers that over
// z.toJSONSchema.
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Standard Schema's JSON Schema extension is untyped in zod's public surface
	const std = schema['~standard'] as {
		jsonSchema: { input: (options: { target: string }) => Record<string, unknown> };
	};
	return std.jsonSchema.input({ target: 'draft-2020-12' });
}

describe('unquoteNumber', () => {
	it('reads a quoted number as the number it spells', () => {
		expect(parse('42').data).toBe(42);
	});

	it('reads a quoted zero as zero', () => {
		expect(section.safeParse('0').data).toBe(0);
	});

	it('leaves an unquoted number alone', () => {
		expect(parse(42).data).toBe(42);
	});

	// Asserted against `section`, not `limit`: a lower bound of 1 would refuse
	// these on its own and the conversion would never be under test. `section`
	// accepts zero, so anything that wrongly converts to zero gets through.
	it('refuses the values that would otherwise coerce to zero', () => {
		expect(section.safeParse('').success).toBe(false);
		expect(section.safeParse(' ').success).toBe(false);
		expect(section.safeParse(null).success).toBe(false);
		expect(section.safeParse(false).success).toBe(false);
		expect(section.safeParse([]).success).toBe(false);
	});

	it('refuses a number spelled in a notation the wire never uses', () => {
		expect(accepts('0x10')).toBe(false);
		expect(accepts('1e3')).toBe(false);
		expect(accepts(' 7 ')).toBe(false);
	});

	it('refuses a string that spells no number', () => {
		expect(accepts('all')).toBe(false);
	});

	it('holds a quoted number to the bounds the wrapped schema sets', () => {
		expect(accepts('501')).toBe(false);
		expect(accepts('500')).toBe(true);
	});

	it('reports a quoted number out of bounds the way the unquoted one is reported', () => {
		expect(parse('501').error?.issues[0].message).toBe(parse(501).error?.issues[0].message);
	});

	it('reports a digit run too long to be a number as the string it is', () => {
		expect(parse('9'.repeat(320)).error?.issues[0].message).toContain('received string');
	});

	// The arrangement update-page uses: the wrapper goes on the numeric member,
	// so a value the numeric branch cannot read falls through to the literal.
	it('lets a value it does not convert fall through to a sibling union branch', () => {
		const sectionOrNew = z.union([section, z.literal('new')]);

		expect(sectionOrNew.safeParse('new').data).toBe('new');
		expect(sectionOrNew.safeParse('2').data).toBe(2);
	});

	it('converts inside an array of numbers', () => {
		const namespaces = z.array(section);

		expect(namespaces.safeParse(['0', '14']).data).toEqual([0, 14]);
	});

	// Wrapping must not quietly relax a required argument into an optional one.
	// The runtime refuses the omission either way, so only the published schema
	// shows the difference — and a caller reading it would omit the argument and
	// get an error the schema said could not happen.
	it('still asks for a required argument', () => {
		const args = z.object({ revisionId: unquoteNumber(z.number().int().positive()) });

		expect(toJsonSchema(args).required).toEqual(['revisionId']);
	});

	it('still lets a caller omit an argument marked optional', () => {
		const args = z.object({ limit: limit.optional() });

		expect(toJsonSchema(args).required).toBeUndefined();
		expect(args.safeParse({}).success).toBe(true);
	});

	it('publishes the wrapped schema, so callers are still asked for a number', () => {
		const plain = z.number().int().min(1).max(500);

		expect(toJsonSchema(unquoteNumber(plain))).toEqual(toJsonSchema(plain));
	});

	// A compile-time assertion, not a runtime one: applying optionality to the
	// argument instead of the result publishes a schema that demands a value the
	// tool treats as optional. `npm run typecheck` fails if the guard is dropped,
	// because an unused @ts-expect-error is itself an error.
	it('refuses optionality applied to its argument rather than its result', () => {
		// @ts-expect-error .optional() belongs outside unquoteNumber
		expect(() => unquoteNumber(z.number().int().optional())).toBeDefined();
		// @ts-expect-error .default() belongs outside unquoteNumber
		expect(() => unquoteNumber(z.number().int().default(50))).toBeDefined();
	});
});
