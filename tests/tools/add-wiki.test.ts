import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( '../../src/common/wikiDiscovery.js', () => ( {
	discoverWiki: vi.fn()
} ) );

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		add: vi.fn()
	}
} ) );

import { discoverWiki } from '../../src/common/wikiDiscovery.js';

describe( 'add-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns an isError tool response when discoverWiki throws (e.g. SSRF rejection)', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue(
			new Error( 'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): http://169.254.169.254/' )
		);

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const server = { sendResourceListChanged: vi.fn() } as unknown as Parameters<typeof handleAddWikiTool>[0];
		const result = await handleAddWikiTool( server, 'http://169.254.169.254/' );

		expect( result.isError ).toBe( true );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toMatch( /169\.254\.169\.254/ );
	} );
} );
