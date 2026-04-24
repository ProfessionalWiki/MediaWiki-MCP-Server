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
			getCurrent: vi.fn(),
			remove: vi.fn()
		}
	};
} );

vi.mock( '../../src/common/mwn.js', () => ( {
	removeMwnInstance: vi.fn()
} ) );

vi.mock( '../../src/resources/index.js', () => ( {
	removeLicenseCache: vi.fn()
} ) );

import { wikiService } from '../../src/common/wikiService.js';
import { removeMwnInstance } from '../../src/common/mwn.js';
import { removeLicenseCache } from '../../src/resources/index.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

const RemoveWikiOutputSchema = z.object( {
	wikiKey: z.string(),
	sitename: z.string(),
	removed: z.literal( true )
} );

describe( 'remove-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'removes the wiki and returns a structured payload', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( {
			sitename: 'Example',
			server: 'https://example.org'
		} as ReturnType<typeof wikiService.get> );
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'other.example.org',
			config: {} as ReturnType<typeof wikiService.getCurrent>[ 'config' ]
		} );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const result = await handleRemoveWikiTool( server, 'mcp://wikis/example.org' );

		const data = assertStructuredSuccess( result, RemoveWikiOutputSchema );
		expect( data ).toEqual( {
			wikiKey: 'example.org',
			sitename: 'Example',
			removed: true
		} );
		expect( vi.mocked( wikiService.remove ) ).toHaveBeenCalledWith( 'example.org' );
		expect( vi.mocked( removeMwnInstance ) ).toHaveBeenCalledWith( 'example.org' );
		expect( vi.mocked( removeLicenseCache ) ).toHaveBeenCalledWith( 'example.org' );
	} );

	it( 'returns invalid_input for a malformed URI', async () => {
		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const result = await handleRemoveWikiTool( server, 'not-a-valid-uri' );

		assertStructuredError( result, 'invalid_input' );
	} );

	it( 'returns invalid_input when the wiki is not registered', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( undefined );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const result = await handleRemoveWikiTool( server, 'mcp://wikis/unknown.example.org' );

		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toMatch(
			/unknown\.example\.org.*not found/
		);
	} );

	it( 'returns conflict when removing the active wiki', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( {
			sitename: 'Example',
			server: 'https://example.org'
		} as ReturnType<typeof wikiService.get> );
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'example.org',
			config: {} as ReturnType<typeof wikiService.getCurrent>[ 'config' ]
		} );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const result = await handleRemoveWikiTool( server, 'mcp://wikis/example.org' );

		assertStructuredError( result, 'conflict' );
		expect( ( result.structuredContent as { message: string } ).message ).toMatch(
			/currently active wiki/
		);
	} );
} );
