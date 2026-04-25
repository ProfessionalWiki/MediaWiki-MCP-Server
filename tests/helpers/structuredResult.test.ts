import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
	assertStructuredSuccess,
	assertStructuredError
} from './structuredResult.js';
import { structuredResult } from '../../src/common/structuredResult.js';
import { errorResult } from '../../src/common/errorMapping.js';

describe( 'assertStructuredSuccess', () => {
	it( 'returns the rendered text on a valid payload', () => {
		const result = structuredResult( { value: 42 } );
		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Value: 42' );
	} );

	it( 'throws when isError is true', () => {
		const result = errorResult( 'invalid_input', 'bad' );
		expect( () => assertStructuredSuccess( result, z.string() ) ).toThrow();
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
