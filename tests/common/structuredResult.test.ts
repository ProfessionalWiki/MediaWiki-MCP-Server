import { describe, it, expect } from 'vitest';
import { structuredResult } from '../../src/common/structuredResult.js';
import { formatPayload } from '../../src/common/formatPayload.js';

// structuredResult renders the payload via formatPayload and rides the result
// in content[0].text. There is no structuredContent and no env-var toggle.
describe( 'structuredResult', () => {
	it( 'emits content-only text and no structuredContent', () => {
		const result = structuredResult( { pageId: 42, title: 'Foo' } );
		expect( result.structuredContent ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( result.content![ 0 ].type ).toBe( 'text' );
		expect( ( result.content![ 0 ] as { text: string } ).text ).toBe(
			formatPayload( { pageId: 42, title: 'Foo' } )
		);
	} );

	it( 'renders nested arrays via the formatter', () => {
		const payload = { revisions: [ { revid: 1 }, { revid: 2 } ] };
		const result = structuredResult( payload );
		const text = ( result.content![ 0 ] as { text: string } ).text;
		expect( text ).toBe( formatPayload( payload ) );
		expect( text ).toContain( 'Revid: 1' );
		expect( text ).toContain( 'Revid: 2' );
	} );

	it( 'omits undefined fields in the rendered text', () => {
		const result = structuredResult( { a: 1, b: undefined } );
		const text = ( result.content![ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'A: 1' );
		expect( text ).not.toContain( 'B:' );
	} );
} );
