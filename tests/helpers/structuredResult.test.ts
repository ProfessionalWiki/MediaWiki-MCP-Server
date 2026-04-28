import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
	assertStructuredSuccess,
	assertStructuredError
} from './structuredResult.js';
import { structuredResult, errorResult } from '../../src/results/response.js';

describe( 'assertStructuredSuccess', () => {
	it( 'returns the rendered text on a valid payload', () => {
		const result = structuredResult( { value: 42 } );
		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Value: 42' );
	} );

	it( 'throws when isError is true', () => {
		const result = errorResult( 'invalid_input', 'bad' );
		expect( () => assertStructuredSuccess( result ) ).toThrow();
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
