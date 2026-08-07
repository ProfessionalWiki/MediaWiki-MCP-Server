import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { allTools } from '../../src/tools/index.ts';

// Every tool argument that accepts an unquoted number, found by probing the
// schema rather than by reading the JSON Schema it publishes. Probing is what
// makes update-page's section show up: a union publishes `anyOf` with no
// top-level `type`, so a walk looking for `type: integer` would skip it.
//
// The convention this enforces is in docs/tool-conventions.md: every numeric
// argument is wrapped in unquoteNumber, because clients send numbers as
// strings. An argument added without the wrapper appears here as a failure
// instead of as a bug report.
const numericArguments = allTools.flatMap((tool) =>
	Object.entries<z.ZodType>(tool.inputSchema).flatMap(([argument, schema]) => {
		if (schema.safeParse(1).success) {
			return [{ tool: tool.name, argument, schema, quoted: '1' as unknown }];
		}
		if (schema.safeParse([1]).success) {
			return [{ tool: tool.name, argument, schema, quoted: ['1'] as unknown }];
		}
		return [];
	}),
);

describe('numeric tool arguments', () => {
	// Without this, an it.each over an empty list reports success having asserted
	// nothing, and a refactor that stopped finding arguments would look green.
	it('finds the numeric arguments across the tool surface', () => {
		expect(numericArguments.length).toBeGreaterThan(20);
	});

	it.each(numericArguments)('$tool $argument accepts a quoted number', ({ schema, quoted }) => {
		expect(schema.safeParse(quoted).success).toBe(true);
	});
});
