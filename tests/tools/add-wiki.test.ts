import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( '../../src/common/wikiDiscovery.js', () => ( {
	discoverWiki: vi.fn()
} ) );

vi.mock( '../../src/common/wikiService.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/wikiService.js' )>(
		'../../src/common/wikiService.js'
	);
	return {
		...actual,
		wikiService: {
			add: vi.fn()
		}
	};
} );

import { z } from 'zod';
import { discoverWiki } from '../../src/common/wikiDiscovery.js';
import { wikiService, DuplicateWikiKeyError } from '../../src/common/wikiService.js';
import { SsrfValidationError } from '../../src/common/ssrfGuard.js';
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'add-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns a structured payload on success', async () => {
		vi.mocked( discoverWiki ).mockResolvedValue( {
			servername: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w'
		} );
		vi.mocked( wikiService.add ).mockImplementation( () => {} );

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'https://example.org/' );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			wikiKey: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w'
		} ) );
		expect( reconcile ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'categorises SSRF rejections as invalid_input', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new SsrfValidationError(
				'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): http://169.254.169.254/'
			)
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'http://169.254.169.254/' );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch(
			/Failed to add wiki:.*169\.254\.169\.254/
		);
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'categorises duplicate-wiki-key failures as conflict', async () => {
		vi.mocked( discoverWiki ).mockResolvedValue( {
			servername: 'example.org',
			sitename: 'Example',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w'
		} );
		vi.mocked( wikiService.add ).mockImplementation( () => {
			throw new DuplicateWikiKeyError( 'example.org' );
		} );

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'https://example.org/' );

		const envelope = assertStructuredError( result, 'conflict' );
		expect( envelope.message ).toBe(
			'Wiki "example.org" already exists in configuration'
		);
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'categorises unexpected discoverWiki errors as upstream_failure', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new Error( 'Connection refused' )
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'https://example.org/' );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch(
			/Failed to add wiki: Connection refused/
		);
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile on the DuplicateWikiKeyError path', async () => {
		vi.mocked( discoverWiki ).mockResolvedValue( {
			servername: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w'
		} );
		vi.mocked( wikiService.add ).mockImplementation( () => {
			throw new DuplicateWikiKeyError( 'example.org' );
		} );

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'https://example.org/' );

		assertStructuredError( result, 'conflict' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile on the SsrfValidationError path', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new SsrfValidationError( 'rejected' )
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const reconcile = vi.fn();
		const result = await handleAddWikiTool( server, reconcile, 'https://example.org/' );

		assertStructuredError( result, 'invalid_input' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );
} );
