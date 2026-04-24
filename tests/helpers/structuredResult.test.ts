import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
	assertStructuredSuccess,
	assertStructuredError
} from './structuredResult.js';
import { structuredResult } from '../../src/common/structuredResult.js';
import { errorResult } from '../../src/common/errorMapping.js';

const TestSchema = z.object( { value: z.number() } );

describe( 'assertStructuredSuccess', () => {
	it( 'passes and returns typed data on a valid payload', () => {
		const result = structuredResult( { value: 42 } );
		const data = assertStructuredSuccess( result, TestSchema );
		expect( data.value ).toBe( 42 );
	} );

	it( 'throws when structuredContent violates the schema', () => {
		const result = structuredResult( { value: 'not a number' } );
		expect( () => assertStructuredSuccess( result, TestSchema ) ).toThrow();
	} );

	it( 'throws when isError is true', () => {
		const result = errorResult( 'invalid_input', 'bad' );
		expect( () => assertStructuredSuccess( result, TestSchema ) ).toThrow();
	} );
} );

describe( 'assertStructuredError', () => {
	it( 'passes for a matching category', () => {
		const result = errorResult( 'not_found', 'missing' );
		expect( () => assertStructuredError( result, 'not_found' ) ).not.toThrow();
	} );

	it( 'passes for a matching category + code', () => {
		const result = errorResult( 'conflict', 'clash', 'editconflict' );
		expect( () => assertStructuredError( result, 'conflict', 'editconflict' ) ).not.toThrow();
	} );

	it( 'throws when category differs', () => {
		const result = errorResult( 'not_found', 'missing' );
		expect( () => assertStructuredError( result, 'conflict' ) ).toThrow();
	} );
} );
