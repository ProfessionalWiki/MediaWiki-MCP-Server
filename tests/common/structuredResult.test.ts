import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Default off mode: payload rides in content[0].text, no structuredContent.
describe( 'structuredResult — default (MCP_STRUCTURED_OUTPUT unset)', () => {
	it( 'emits content-only JSON text and no structuredContent', async () => {
		const { structuredResult } = await import( '../../src/common/structuredResult.js' );
		const result = structuredResult( { pageId: 42, title: 'Foo' } );
		expect( result.structuredContent ).toBeUndefined();
		expect( result.content ).toHaveLength( 1 );
		expect( result.content![ 0 ].type ).toBe( 'text' );
		expect( JSON.parse( ( result.content![ 0 ] as { text: string } ).text ) )
			.toEqual( { pageId: 42, title: 'Foo' } );
	} );

	it( 'serializes nested arrays into the JSON text block', async () => {
		const { structuredResult } = await import( '../../src/common/structuredResult.js' );
		const payload = { revisions: [ { revid: 1 }, { revid: 2 } ] };
		const result = structuredResult( payload );
		const parsed = JSON.parse( ( result.content![ 0 ] as { text: string } ).text );
		expect( parsed.revisions ).toHaveLength( 2 );
	} );

	it( 'drops undefined fields in JSON (matches JSON.stringify semantics)', async () => {
		const { structuredResult } = await import( '../../src/common/structuredResult.js' );
		const result = structuredResult( { a: 1, b: undefined } );
		expect( JSON.parse( ( result.content![ 0 ] as { text: string } ).text ) )
			.toEqual( { a: 1 } );
	} );
} );

// Opt-in on mode: payload rides in structuredContent, content is empty.
describe( 'structuredResult — on (MCP_STRUCTURED_OUTPUT=true)', () => {
	beforeEach( () => {
		vi.stubEnv( 'MCP_STRUCTURED_OUTPUT', 'true' );
		vi.resetModules();
	} );
	afterEach( () => {
		vi.unstubAllEnvs();
		vi.resetModules();
	} );

	it( 'emits structuredContent and empty content array', async () => {
		const { structuredResult } = await import( '../../src/common/structuredResult.js' );
		const result = structuredResult( { pageId: 42, title: 'Foo' } );
		expect( result.structuredContent ).toEqual( { pageId: 42, title: 'Foo' } );
		expect( result.content ).toEqual( [] );
	} );

	it( 'preserves undefined fields on structuredContent even though JSON would drop them', async () => {
		const { structuredResult } = await import( '../../src/common/structuredResult.js' );
		const result = structuredResult( { a: 1, b: undefined } );
		expect( result.structuredContent ).toEqual( { a: 1, b: undefined } );
	} );
} );
