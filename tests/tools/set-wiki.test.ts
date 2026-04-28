import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WikiConfig } from '../../src/common/config.js';
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';
import { fakeManagementContext } from '../helpers/fakeContext.js';
import { setWiki } from '../../src/tools/set-wiki.js';
import { dispatch } from '../../src/runtime/dispatcher.js';

function wikiConfig( overrides: Partial<WikiConfig> = {} ): WikiConfig {
	return {
		sitename: 'Example',
		server: 'https://example.org',
		articlepath: '/wiki',
		scriptpath: '/w',
		...overrides
	} as WikiConfig;
}

describe( 'set-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'switches the active wiki and returns the new config', async () => {
		const reconcile = vi.fn();
		const setCurrent = vi.fn();
		let currentKey = 'default';
		const ctx = fakeManagementContext( {
			reconcile,
			wikis: {
				getAll: () => ( {} ),
				get: () => wikiConfig(),
				add: () => {},
				remove: () => {},
				isManagementAllowed: () => true
			},
			selection: {
				getCurrent: () => ( { key: currentKey, config: wikiConfig() } ),
				setCurrent: ( key: string ) => {
					setCurrent( key );
					currentKey = key;
				},
				reset: () => {}
			}
		} );
		const result = await dispatch( setWiki, ctx )( { uri: 'mcp://wikis/example.org' } );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			wikiKey: 'example.org',
			sitename: 'Example',
			server: 'https://example.org'
		} ) );
		expect( setCurrent ).toHaveBeenCalledWith( 'example.org' );
		expect( reconcile ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns invalid_input for a malformed URI', async () => {
		const ctx = fakeManagementContext();
		const result = await dispatch( setWiki, ctx )( { uri: 'not-a-valid-uri' } );

		assertStructuredError( result, 'invalid_input' );
	} );

	it( 'returns invalid_input when the wiki is not registered', async () => {
		const ctx = fakeManagementContext( {
			wikis: {
				getAll: () => ( {} ),
				get: () => undefined,
				add: () => {},
				remove: () => {},
				isManagementAllowed: () => true
			}
		} );
		const result = await dispatch( setWiki, ctx )( { uri: 'mcp://wikis/unknown.example.org' } );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch(
			/unknown\.example\.org.*not found/
		);
	} );
} );
