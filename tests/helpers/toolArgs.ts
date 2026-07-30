import { z, type ZodRawShape } from 'zod';
import type { Tool } from '../../src/runtime/tool.ts';

// Applies a tool's own schema defaults to a partial argument object, producing
// exactly what the handler receives once the SDK has parsed the call. Calling
// `handle` with a bare literal instead skips that parse, so a test asserting a
// defaulted value proves only that the handler's own fallback fired, never that
// the schema declares the default it documents.
//
// Parses against the tool's static schema, so the per-call `wiki` argument that
// register() merges in at registration time is not accepted here. A test driving
// dispatch()'s wiki resolution has to pass its args directly.
export function toolArgs<TSchema extends ZodRawShape>(
	tool: Tool<TSchema>,
	input: z.input<z.ZodObject<TSchema>>,
): z.infer<z.ZodObject<TSchema>> {
	return z.object(tool.inputSchema).parse(input);
}
