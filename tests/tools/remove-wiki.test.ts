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
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

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
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'mcp://wikis/example.org' );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			wikiKey: 'example.org',
			sitename: 'Example',
			removed: true
		} ) );
		expect( vi.mocked( wikiService.remove ) ).toHaveBeenCalledWith( 'example.org' );
		expect( vi.mocked( removeMwnInstance ) ).toHaveBeenCalledWith( 'example.org' );
		expect( vi.mocked( removeLicenseCache ) ).toHaveBeenCalledWith( 'example.org' );
		expect( reconcile ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns invalid_input for a malformed URI', async () => {
		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'not-a-valid-uri' );

		assertStructuredError( result, 'invalid_input' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'returns invalid_input when the wiki is not registered', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( undefined );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'mcp://wikis/unknown.example.org' );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch(
			/unknown\.example\.org.*not found/
		);
		expect( reconcile ).not.toHaveBeenCalled();
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
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'mcp://wikis/example.org' );

		const envelope = assertStructuredError( result, 'conflict' );
		expect( envelope.message ).toMatch(
			/currently active wiki/
		);
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile when removing the currently active wiki', async () => {
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
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'mcp://wikis/example.org' );

		assertStructuredError( result, 'conflict' );
		expect( reconcile ).not.toHaveBeenCalled();
		expect( vi.mocked( wikiService.remove ) ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile on InvalidWikiResourceUriError', async () => {
		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleRemoveWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool( server, reconcile, 'not-a-mcp-uri' );

		assertStructuredError( result, 'invalid_input' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );
} );
