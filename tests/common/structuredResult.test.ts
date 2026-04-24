import { describe, it, expect } from 'vitest';
import { structuredResult } from '../../src/common/structuredResult.js';

describe( 'structuredResult', () => {
	it( 'wraps a flat object as structuredContent with JSON fallback', () => {
		const result = structuredResult( { pageId: 42, title: 'Foo' } );
		expect( result.structuredContent ).toEqual( { pageId: 42, title: 'Foo' } );
		expect( result.content ).toHaveLength( 1 );
		expect( result.content![ 0 ].type ).toBe( 'text' );
		expect( JSON.parse( ( result.content![ 0 ] as { text: string } ).text ) )
			.toEqual( { pageId: 42, title: 'Foo' } );
	} );

	it( 'serializes nested arrays', () => {
		const payload = { revisions: [ { revid: 1 }, { revid: 2 } ], truncation: undefined };
		const result = structuredResult( payload );
		const parsed = JSON.parse( ( result.content![ 0 ] as { text: string } ).text );
		expect( parsed.revisions ).toHaveLength( 2 );
	} );

	it( 'drops undefined fields in JSON but preserves them on structuredContent', () => {
		const payload = { a: 1, b: undefined };
		const result = structuredResult( payload );
		expect( result.structuredContent ).toEqual( { a: 1, b: undefined } );
		expect( JSON.parse( ( result.content![ 0 ] as { text: string } ).text ) )
			.toEqual( { a: 1 } );
	} );
} );
