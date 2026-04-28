import { describe, it, expect } from 'vitest';
import { WikiSelectionImpl } from '../../src/wikis/wikiSelection.js';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/common/config.js';

const sample = ( name: string ): WikiConfig => ( {
	sitename: name,
	server: `https://${ name }`,
	articlepath: '/wiki',
	scriptpath: '/w'
} );

describe( 'WikiSelectionImpl', () => {
	it( 'getCurrent returns the default wiki initially', () => {
		const reg = new WikiRegistryImpl( { a: sample( 'a' ), b: sample( 'b' ) }, true );
		const sel = new WikiSelectionImpl( 'a', reg );
		expect( sel.getCurrent().key ).toBe( 'a' );
		expect( sel.getCurrent().config.sitename ).toBe( 'a' );
	} );

	it( 'getCurrent throws when the current wiki was removed from the registry', () => {
		const reg = new WikiRegistryImpl( { a: sample( 'a' ) }, true );
		const sel = new WikiSelectionImpl( 'a', reg );
		reg.remove( 'a' );
		expect( () => sel.getCurrent() ).toThrow( /not found/ );
	} );

	it( 'setCurrent switches to a known wiki', () => {
		const reg = new WikiRegistryImpl( { a: sample( 'a' ), b: sample( 'b' ) }, true );
		const sel = new WikiSelectionImpl( 'a', reg );
		sel.setCurrent( 'b' );
		expect( sel.getCurrent().key ).toBe( 'b' );
	} );

	it( 'setCurrent throws for unknown wiki', () => {
		const reg = new WikiRegistryImpl( { a: sample( 'a' ) }, true );
		const sel = new WikiSelectionImpl( 'a', reg );
		expect( () => sel.setCurrent( 'unknown' ) ).toThrow( /not found/ );
	} );

	it( 'reset returns to the default', () => {
		const reg = new WikiRegistryImpl( { a: sample( 'a' ), b: sample( 'b' ) }, true );
		const sel = new WikiSelectionImpl( 'a', reg );
		sel.setCurrent( 'b' );
		sel.reset();
		expect( sel.getCurrent().key ).toBe( 'a' );
	} );

	it( 'reset throws when default is missing', () => {
		const reg = new WikiRegistryImpl( {}, true );
		const sel = new WikiSelectionImpl( 'gone', reg );
		expect( () => sel.reset() ).toThrow( /not found/ );
	} );
} );
