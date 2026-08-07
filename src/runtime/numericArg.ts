import { z } from 'zod';

// A bare run of decimal digits, optionally signed. Deliberately narrow: no
// surrounding whitespace, no decimal point, no exponent, no hex prefix. `\d`
// without the `u` flag is ASCII-only, so `٢` and `２` are refused — which is
// the right answer, since `Number()` reads both as NaN.
const QUOTED_INTEGER = /^-?\d+$/;

// Refuses a schema that already carries its own optionality. `.optional()` and
// `.default()` belong on the result of unquoteNumber, never on its argument:
// applied to the argument, the `.nonoptional()` below cancels them, and the
// published schema then demands a value the tool treats as optional.
type NotAlreadyOptional<T> = T extends z.ZodOptional<z.ZodType> | z.ZodDefault<z.ZodType>
	? never
	: T;

/**
 * Wraps a numeric argument schema so a client that spells the number as a
 * string — `"2"` rather than `2` — is understood. MCP clients quote numeric
 * tool arguments often enough that a strict schema turns an otherwise
 * well-formed call into a failure the caller cannot account for from the
 * request it sent.
 *
 * Only the digits form converts. Everything else reaches the wrapped schema
 * untouched and is refused there, including every value `Number()` reads as
 * zero: `""`, `" "`, `null`, `false`, `[]`. That distinction carries real
 * weight on update-page, where section 0 is the page's lead.
 *
 * The published JSON Schema is the wrapped schema's, unchanged, so clients are
 * still told to send a number.
 */
export function unquoteNumber<T extends z.ZodType>(schema: T & NotAlreadyOptional<T>) {
	const unquoted = z.preprocess((value) => {
		if (typeof value !== 'string' || !QUOTED_INTEGER.test(value)) {
			return value;
		}
		// A digit run long enough to overflow to Infinity is handed back as the
		// string it came in as, so the wrapped schema reports the type it was
		// given rather than the nonsense number it would otherwise see.
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : value;
	}, schema);

	// A preprocess step accepts `unknown`, and `unknown` admits `undefined`, so
	// wrapping alone would make every argument an optional one. Callers that want
	// the argument optional say so themselves, after this.
	return unquoted.nonoptional();
}
