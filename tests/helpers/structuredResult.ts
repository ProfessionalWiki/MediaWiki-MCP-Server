import { expect } from 'vitest';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import {
	ErrorEnvelopeSchema,
	type ErrorEnvelope
} from '../../src/results/schemas.js';

// Tool responses ride entirely in content[0].text. Successful responses carry
// the typed payload as labelled prose (formatPayload); error responses carry
// a JSON-serialised ErrorEnvelope plus isError=true. These helpers assert the
// shared envelope conventions and return the inner data so tests can match
// against substrings (success) or envelope fields (error).

export function assertStructuredSuccess( result: CallToolResult ): string {
	expect( result.isError ).toBeFalsy();
	expect( result.structuredContent ).toBeUndefined();
	expect( result.content ).toHaveLength( 1 );
	expect( result.content![ 0 ].type ).toBe( 'text' );
	return ( result.content![ 0 ] as TextContent ).text;
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
