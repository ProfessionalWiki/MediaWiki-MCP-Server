import { describe, it, expect } from 'vitest';
import { RevisionNormalizerImpl } from '../../src/services/revisionNormalize.js';

describe( 'RevisionNormalizerImpl', () => {
	const norm = new RevisionNormalizerImpl();

	it( 'hoists slots.main onto the revision', () => {
		const result = norm.normalise( {
			revid: 1,
			slots: { main: { content: 'hello', contentmodel: 'wikitext', size: 5 } }
		} );
		expect( result ).toMatchObject( {
			revid: 1,
			content: 'hello',
			contentmodel: 'wikitext',
			size: 5
		} );
	} );

	it( 'removes the slots field from the output', () => {
		const result = norm.normalise( {
			revid: 1,
			slots: { main: { content: 'hello' } }
		} );
		expect( result ).not.toHaveProperty( 'slots' );
	} );

	it( 'leaves revisions without slots untouched (apart from removing slots field)', () => {
		const result = norm.normalise( { revid: 1, content: 'plain' } );
		expect( result ).toEqual( { revid: 1, content: 'plain' } );
	} );

	it( 'prefers slots.main over top-level when both are present', () => {
		const result = norm.normalise( {
			revid: 1,
			content: 'top',
			slots: { main: { content: 'inner' } }
		} );
		expect( result.content ).toBe( 'inner' );
	} );
} );
