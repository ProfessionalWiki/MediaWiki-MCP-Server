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

import { discoverWiki } from '../../src/common/wikiDiscovery.js';
import { wikiService, DuplicateWikiKeyError } from '../../src/common/wikiService.js';
import { SsrfValidationError } from '../../src/common/ssrfGuard.js';
import { assertStructuredError } from '../helpers/structuredResult.js';

describe( 'add-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'categorises SSRF rejections as invalid_input', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new SsrfValidationError(
				'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): http://169.254.169.254/'
			)
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const result = await handleAddWikiTool( server, 'http://169.254.169.254/' );

		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toMatch(
			/Failed to add wiki:.*169\.254\.169\.254/
		);
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
		const result = await handleAddWikiTool( server, 'https://example.org/' );

		assertStructuredError( result, 'conflict' );
		expect( ( result.structuredContent as { message: string } ).message ).toBe(
			'Wiki "example.org" already exists in configuration'
		);
	} );

	it( 'categorises unexpected discoverWiki errors as upstream_failure', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new Error( 'Connection refused' )
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const result = await handleAddWikiTool( server, 'https://example.org/' );

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toMatch(
			/Failed to add wiki: Connection refused/
		);
	} );
} );
