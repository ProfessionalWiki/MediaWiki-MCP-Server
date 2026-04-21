import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/common/config.js';

function setConfig( config: Partial<Config> ): void {
	vi.doMock( '../../src/common/config.js', async ( importOriginal ) => {
		const actual = await importOriginal<typeof import( '../../src/common/config.js' )>();
		return {
			...actual,
			loadConfigFromFile: vi.fn().mockReturnValue( {
				defaultWiki: 'test-wiki',
				wikis: {
					'test-wiki': {
						sitename: 'Test',
						server: 'https://test.example',
						articlepath: '/wiki',
						scriptpath: '/w'
					}
				},
				...config
			} )
		};
	} );
}

describe( 'wikiService.isWikiManagementAllowed', () => {
	beforeEach( () => {
		vi.resetModules();
	} );

	it( 'returns true when allowWikiManagement is undefined', async () => {
		setConfig( {} );
		const { wikiService } = await import( '../../src/common/wikiService.js' );
		expect( wikiService.isWikiManagementAllowed() ).toBe( true );
	} );

	it( 'returns true when allowWikiManagement is true', async () => {
		setConfig( { allowWikiManagement: true } );
		const { wikiService } = await import( '../../src/common/wikiService.js' );
		expect( wikiService.isWikiManagementAllowed() ).toBe( true );
	} );

	it( 'returns false when allowWikiManagement is false', async () => {
		setConfig( { allowWikiManagement: false } );
		const { wikiService } = await import( '../../src/common/wikiService.js' );
		expect( wikiService.isWikiManagementAllowed() ).toBe( false );
	} );
} );
