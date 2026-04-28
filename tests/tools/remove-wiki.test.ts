import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WikiConfig } from '../../src/config/loadConfig.js';
import { formatPayload } from '../../src/results/format.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';
import { fakeManagementContext } from '../helpers/fakeContext.js';
import { removeWiki } from '../../src/tools/remove-wiki.js';
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

describe( 'remove-wiki', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'removes the wiki and returns a structured payload', async () => {
		const reconcile = vi.fn();
		const remove = vi.fn();
		const invalidate = vi.fn();
		const ctx = fakeManagementContext( {
			reconcile,
			wikiCache: { invalidate },
			wikis: {
				getAll: () => ( {} ),
				get: () => wikiConfig(),
				add: () => {},
				remove,
				isManagementAllowed: () => true
			},
			selection: {
				getCurrent: () => ( {
					key: 'other.example.org',
					config: wikiConfig()
				} ),
				setCurrent: () => {},
				reset: () => {}
			}
		} );
		const result = await dispatch( removeWiki, ctx )( { uri: 'mcp://wikis/example.org' } );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			wikiKey: 'example.org',
			sitename: 'Example',
			removed: true
		} ) );
		expect( remove ).toHaveBeenCalledWith( 'example.org' );
		expect( invalidate ).toHaveBeenCalledWith( 'example.org' );
		expect( reconcile ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns invalid_input for a malformed URI', async () => {
		const reconcile = vi.fn();
		const ctx = fakeManagementContext( { reconcile } );
		const result = await dispatch( removeWiki, ctx )( { uri: 'not-a-valid-uri' } );

		assertStructuredError( result, 'invalid_input' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'returns invalid_input when the wiki is not registered', async () => {
		const reconcile = vi.fn();
		const ctx = fakeManagementContext( {
			reconcile,
			wikis: {
				getAll: () => ( {} ),
				get: () => undefined,
				add: () => {},
				remove: () => {},
				isManagementAllowed: () => true
			}
		} );
		const result = await dispatch( removeWiki, ctx )( { uri: 'mcp://wikis/unknown.example.org' } );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch(
			/unknown\.example\.org.*not found/
		);
		expect( reconcile ).not.toHaveBeenCalled();
	} );

	it( 'returns conflict when removing the active wiki', async () => {
		const reconcile = vi.fn();
		const remove = vi.fn();
		const ctx = fakeManagementContext( {
			reconcile,
			wikis: {
				getAll: () => ( {} ),
				get: () => wikiConfig(),
				add: () => {},
				remove,
				isManagementAllowed: () => true
			},
			selection: {
				getCurrent: () => ( {
					key: 'example.org',
					config: wikiConfig()
				} ),
				setCurrent: () => {},
				reset: () => {}
			}
		} );
		const result = await dispatch( removeWiki, ctx )( { uri: 'mcp://wikis/example.org' } );

		const envelope = assertStructuredError( result, 'conflict' );
		expect( envelope.message ).toMatch(
			/currently active wiki/
		);
		expect( reconcile ).not.toHaveBeenCalled();
		expect( remove ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile when removing the currently active wiki', async () => {
		const reconcile = vi.fn();
		const remove = vi.fn();
		const ctx = fakeManagementContext( {
			reconcile,
			wikis: {
				getAll: () => ( {} ),
				get: () => wikiConfig(),
				add: () => {},
				remove,
				isManagementAllowed: () => true
			},
			selection: {
				getCurrent: () => ( {
					key: 'example.org',
					config: wikiConfig()
				} ),
				setCurrent: () => {},
				reset: () => {}
			}
		} );
		const result = await dispatch( removeWiki, ctx )( { uri: 'mcp://wikis/example.org' } );

		assertStructuredError( result, 'conflict' );
		expect( reconcile ).not.toHaveBeenCalled();
		expect( remove ).not.toHaveBeenCalled();
	} );

	it( 'does not call reconcile on InvalidWikiResourceUriError', async () => {
		const reconcile = vi.fn();
		const ctx = fakeManagementContext( { reconcile } );
		const result = await dispatch( removeWiki, ctx )( { uri: 'not-a-mcp-uri' } );

		assertStructuredError( result, 'invalid_input' );
		expect( reconcile ).not.toHaveBeenCalled();
	} );
} );
