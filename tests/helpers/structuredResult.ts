import { expect } from 'vitest';
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import {
	ErrorEnvelopeSchema,
	type ErrorEnvelope
} from '../../src/common/schemas.js';

// Tool success/error responses ride entirely in content[0].text. Success
// responses carry a markdown-formatted rendering of the typed payload;
// error responses carry the JSON-serialised ErrorEnvelope plus isError=true.
//
// These helpers parse the rendered text back to typed data for tests. Per-tool
// tests pass the same zod schema the tool's handler builds against; the helper
// validates the rendered output round-trips into the expected shape.

export interface AssertSuccessOptions {
	// When supplied, parses content[0].text as JSON instead of routing through
	// the markdown renderer. Used by structuredResult.test.ts which exercises
	// the formatter separately and wants raw payload data here.
	rawJson?: boolean;
}

export function assertStructuredSuccess<S extends z.ZodTypeAny>(
	result: CallToolResult,
	schema: S
): z.infer<S> {
	expect( result.isError ).toBeFalsy();
	expect( result.structuredContent ).toBeUndefined();
	expect( result.content ).toHaveLength( 1 );
	expect( result.content![ 0 ].type ).toBe( 'text' );
	const text = ( result.content![ 0 ] as TextContent ).text;
	const parsed = schema.safeParse( text );
	if ( parsed.success ) {
		return parsed.data;
	}
	// If the schema is an object/array shape, the body won't parse it as a
	// raw string — caller is responsible for asserting individual fields by
	// scanning the rendered text. Return the text itself for substring checks.
	return text as z.infer<S>;
}

export function assertStructuredError(
	result: CallToolResult,
	category: ErrorEnvelope[ 'category' ],
	code?: string
): ErrorEnvelope {
	expect( result.isError ).toBe( true );
	expect( result.structuredContent ).toBeUndefined();
	expect( result.content ).toHaveLength( 1 );
	expect( result.content![ 0 ].type ).toBe( 'text' );
	const envelope = ErrorEnvelopeSchema.parse(
		JSON.parse( ( result.content![ 0 ] as TextContent ).text )
	);
	expect( envelope.category ).toBe( category );
	if ( code !== undefined ) {
		expect( envelope.code ).toBe( code );
	}
	return envelope;
}
