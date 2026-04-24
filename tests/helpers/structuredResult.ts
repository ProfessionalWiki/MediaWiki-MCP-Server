import { expect } from 'vitest';
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import {
	ErrorEnvelopeSchema,
	type ErrorEnvelope
} from '../../src/common/schemas.js';

export function assertStructuredSuccess<S extends z.ZodTypeAny>(
	result: CallToolResult,
	schema: S
): z.infer<S> {
	expect( result.isError ).toBeFalsy();
	// Structured-output on: payload is in structuredContent, content is empty.
	// Structured-output off (default): payload is JSON in content[0].text, no
	// structuredContent. The helper accepts either.
	const hasStructured = result.structuredContent !== undefined;
	const hasContentPayload = ( result.content?.length ?? 0 ) > 0;
	expect( hasStructured || hasContentPayload ).toBe( true );

	let raw: unknown;
	if ( hasContentPayload ) {
		expect( result.content![ 0 ].type ).toBe( 'text' );
		raw = JSON.parse( ( result.content![ 0 ] as TextContent ).text );
		// When both channels are populated they must agree after a JSON round-trip
		// (which drops undefined fields, matching what JSON.stringify emits).
		if ( hasStructured ) {
			expect( raw ).toEqual(
				JSON.parse( JSON.stringify( result.structuredContent ) )
			);
		}
	} else {
		raw = result.structuredContent;
	}

	const parsed = schema.safeParse( raw );
	if ( !parsed.success ) {
		throw new Error(
			`tool output failed schema validation: ${ JSON.stringify( parsed.error.issues ) }`
		);
	}
	return parsed.data;
}

export function assertStructuredError(
	result: CallToolResult,
	category: ErrorEnvelope[ 'category' ],
	code?: string
): ErrorEnvelope {
	expect( result.isError ).toBe( true );
	// Error envelopes ride in content[0].text as JSON rather than as
	// structuredContent, so that they don't get rejected by strict MCP
	// clients validating against a tool's success outputSchema.
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
