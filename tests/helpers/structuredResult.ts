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
	expect( result.structuredContent ).toBeDefined();
	const parsed = schema.safeParse( result.structuredContent );
	if ( !parsed.success ) {
		throw new Error(
			`structuredContent failed schema validation: ${ JSON.stringify( parsed.error.issues ) }`
		);
	}
	expect( result.content ).toHaveLength( 1 );
	expect( result.content![ 0 ].type ).toBe( 'text' );
	const fallback = JSON.parse( ( result.content![ 0 ] as TextContent ).text );
	expect( fallback ).toEqual( JSON.parse( JSON.stringify( result.structuredContent ) ) );
	return parsed.data;
}

export function assertStructuredError(
	result: CallToolResult,
	category: ErrorEnvelope[ 'category' ],
	code?: string
): ErrorEnvelope {
	expect( result.isError ).toBe( true );
	const envelope = ErrorEnvelopeSchema.parse( result.structuredContent );
	expect( envelope.category ).toBe( category );
	if ( code !== undefined ) {
		expect( envelope.code ).toBe( code );
	}
	expect( result.content ).toHaveLength( 1 );
	expect( result.content![ 0 ].type ).toBe( 'text' );
	expect( JSON.parse( ( result.content![ 0 ] as TextContent ).text ) ).toEqual( envelope );
	return envelope;
}
