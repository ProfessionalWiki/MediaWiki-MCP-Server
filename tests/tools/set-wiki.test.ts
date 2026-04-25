import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock( '../../src/common/wikiService.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/wikiService.js' )>(
		'../../src/common/wikiService.js'
	);
	return {
		...actual,
		wikiService: {
			get: vi.fn(),
			setCurrent: vi.fn(),
			getCurrent: vi.fn()
		}
	};
} );

import { wikiService } from '../../src/common/wikiService.js';
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'set-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'switches the active wiki and returns the new config', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( {
			sitename: 'Example',
			server: 'https://example.org'
		} as ReturnType<typeof wikiService.get> );
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'example.org',
			config: {
				sitename: 'Example',
				server: 'https://example.org'
			} as ReturnType<typeof wikiService.getCurrent>[ 'config' ]
		} );

		const onActiveWikiChanged = vi.fn();
		const { handleSetWikiTool } = await import( '../../src/tools/set-wiki.js' );
		const result = await handleSetWikiTool( 'mcp://wikis/example.org', onActiveWikiChanged );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			wikiKey: 'example.org',
			sitename: 'Example',
			server: 'https://example.org'
		} ) );
		expect( vi.mocked( wikiService.setCurrent ) ).toHaveBeenCalledWith( 'example.org' );
		expect( onActiveWikiChanged ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns invalid_input for a malformed URI', async () => {
		const { handleSetWikiTool } = await import( '../../src/tools/set-wiki.js' );
		const result = await handleSetWikiTool( 'not-a-valid-uri', vi.fn() );

		assertStructuredError( result, 'invalid_input' );
	} );

	it( 'returns invalid_input when the wiki is not registered', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( undefined );

		const { handleSetWikiTool } = await import( '../../src/tools/set-wiki.js' );
		const result = await handleSetWikiTool( 'mcp://wikis/unknown.example.org', vi.fn() );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch(
			/unknown\.example\.org.*not found/
		);
	} );
} );
