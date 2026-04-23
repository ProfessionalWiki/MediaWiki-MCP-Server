import { describe, it, expect, vi } from 'vitest';
/* eslint-disable n/no-missing-import */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import type { WikiConfig } from '../../src/common/config.js';
import { reconcileToolsForActiveWiki } from '../../src/tools/reconcile.js';

const WRITE_TOOL_NAMES = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url'
];

const NON_WRITE_TOOL_NAMES = [ 'get-page', 'search-page', 'set-wiki' ];

interface MockTool {
	enabled: boolean;
	enable: ReturnType<typeof vi.fn>;
	disable: ReturnType<typeof vi.fn>;
}

function makeMockTool( initiallyEnabled: boolean ): MockTool {
	const tool: MockTool = {
		enabled: initiallyEnabled,
		enable: vi.fn( () => {
			tool.enabled = true;
		} ),
		disable: vi.fn( () => {
			tool.enabled = false;
		} )
	};
	return tool;
}

function makeToolMap( initiallyEnabled: boolean ): {
	tools: Map<string, RegisteredTool>;
	mocks: Map<string, MockTool>;
} {
	const mocks = new Map<string, MockTool>();
	const tools = new Map<string, RegisteredTool>();
	for ( const name of [ ...WRITE_TOOL_NAMES, ...NON_WRITE_TOOL_NAMES ] ) {
		const mock = makeMockTool( initiallyEnabled );
		mocks.set( name, mock );
		tools.set( name, mock as unknown as RegisteredTool );
	}
	return { tools, mocks };
}

const baseWiki: WikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w'
};

describe( 'reconcileToolsForActiveWiki', () => {
	it( 'disables every write tool when the active wiki is readOnly', () => {
		const { tools, mocks } = makeToolMap( true );
		reconcileToolsForActiveWiki( tools, { ...baseWiki, readOnly: true } );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.disable ).toHaveBeenCalledTimes( 1 );
			expect( mocks.get( name )!.enable ).not.toHaveBeenCalled();
		}
	} );

	it( 'does not touch non-write tools', () => {
		const { tools, mocks } = makeToolMap( true );
		reconcileToolsForActiveWiki( tools, { ...baseWiki, readOnly: true } );
		for ( const name of NON_WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.disable ).not.toHaveBeenCalled();
			expect( mocks.get( name )!.enable ).not.toHaveBeenCalled();
		}
	} );

	it( 'enables every write tool when the active wiki is not readOnly', () => {
		const { tools, mocks } = makeToolMap( false );
		reconcileToolsForActiveWiki( tools, { ...baseWiki, readOnly: false } );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.enable ).toHaveBeenCalledTimes( 1 );
			expect( mocks.get( name )!.disable ).not.toHaveBeenCalled();
		}
	} );

	it( 'treats missing readOnly as non-readOnly', () => {
		const { tools, mocks } = makeToolMap( false );
		reconcileToolsForActiveWiki( tools, baseWiki );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.enable ).toHaveBeenCalledTimes( 1 );
		}
	} );

	it( 'is idempotent: a second call with identical state performs zero toggles', () => {
		const { tools, mocks } = makeToolMap( true );
		const wiki = { ...baseWiki, readOnly: true };
		reconcileToolsForActiveWiki( tools, wiki );
		for ( const m of mocks.values() ) {
			m.enable.mockClear();
			m.disable.mockClear();
		}
		reconcileToolsForActiveWiki( tools, wiki );
		for ( const m of mocks.values() ) {
			expect( m.enable ).not.toHaveBeenCalled();
			expect( m.disable ).not.toHaveBeenCalled();
		}
	} );

	it( 'skips tools missing from the map', () => {
		const { tools, mocks } = makeToolMap( true );
		tools.delete( 'upload-file' );
		expect( () => reconcileToolsForActiveWiki( tools, { ...baseWiki, readOnly: true } ) ).not.toThrow();
		for ( const name of WRITE_TOOL_NAMES ) {
			if ( name === 'upload-file' ) {
				continue;
			}
			expect( mocks.get( name )!.disable ).toHaveBeenCalledTimes( 1 );
		}
	} );
} );
