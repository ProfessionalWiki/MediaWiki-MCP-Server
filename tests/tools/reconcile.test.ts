import { describe, it, expect, vi } from 'vitest';
/* eslint-disable n/no-missing-import */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import type { WikiConfig } from '../../src/common/config.js';
import { reconcileTools } from '../../src/tools/reconcile.js';

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn(),
		getAll: vi.fn(),
		isWikiManagementAllowed: vi.fn()
	}
} ) );

import { wikiService } from '../../src/common/wikiService.js';

const WRITE_TOOL_NAMES = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url'
];

const NON_WRITE_TOOL_NAMES = [ 'get-page', 'search-page' ];
const WIKI_SET_TOOL_NAMES = [ 'add-wiki', 'remove-wiki', 'set-wiki' ];

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
	for ( const name of [ ...WRITE_TOOL_NAMES, ...NON_WRITE_TOOL_NAMES, ...WIKI_SET_TOOL_NAMES ] ) {
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

function setup( {
	activeWiki,
	wikis,
	allowManagement
}: {
	activeWiki: WikiConfig;
	wikis: Record<string, WikiConfig>;
	allowManagement: boolean;
} ): void {
	vi.mocked( wikiService.getCurrent ).mockReturnValue( {
		key: Object.keys( wikis ).find( ( k ) => wikis[ k ] === activeWiki ) ?? 'a',
		config: activeWiki
	} );
	vi.mocked( wikiService.getAll ).mockReturnValue( wikis );
	vi.mocked( wikiService.isWikiManagementAllowed ).mockReturnValue( allowManagement );
}

describe( 'reconcileTools — applyReadOnlyRule', () => {
	it( 'disables every write tool when the active wiki is readOnly', () => {
		const { tools, mocks } = makeToolMap( true );
		const wiki = { ...baseWiki, readOnly: true };
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.disable ).toHaveBeenCalledTimes( 1 );
			expect( mocks.get( name )!.enable ).not.toHaveBeenCalled();
		}
	} );

	it( 'does not touch non-write tools', () => {
		const { tools, mocks } = makeToolMap( true );
		const wiki = { ...baseWiki, readOnly: true };
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const name of NON_WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.disable ).not.toHaveBeenCalled();
			expect( mocks.get( name )!.enable ).not.toHaveBeenCalled();
		}
	} );

	it( 'enables every write tool when the active wiki is not readOnly', () => {
		const { tools, mocks } = makeToolMap( false );
		const wiki = { ...baseWiki, readOnly: false };
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.enable ).toHaveBeenCalledTimes( 1 );
			expect( mocks.get( name )!.disable ).not.toHaveBeenCalled();
		}
	} );

	it( 'treats missing readOnly as non-readOnly', () => {
		const { tools, mocks } = makeToolMap( false );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const name of WRITE_TOOL_NAMES ) {
			expect( mocks.get( name )!.enable ).toHaveBeenCalledTimes( 1 );
		}
	} );

	it( 'is idempotent: a second call with identical state performs zero toggles', () => {
		const { tools, mocks } = makeToolMap( true );
		const wiki = { ...baseWiki, readOnly: true };
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const m of mocks.values() ) {
			m.enable.mockClear();
			m.disable.mockClear();
		}
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const m of mocks.values() ) {
			expect( m.enable ).not.toHaveBeenCalled();
			expect( m.disable ).not.toHaveBeenCalled();
		}
	} );

	it( 'skips tools missing from the map', () => {
		const { tools, mocks } = makeToolMap( true );
		tools.delete( 'upload-file' );
		const wiki = { ...baseWiki, readOnly: true };
		setup( {
			activeWiki: wiki,
			wikis: { a: wiki },
			allowManagement: true
		} );
		expect( () => reconcileTools( tools ) ).not.toThrow();
		for ( const name of WRITE_TOOL_NAMES ) {
			if ( name === 'upload-file' ) {
				continue;
			}
			expect( mocks.get( name )!.disable ).toHaveBeenCalledTimes( 1 );
		}
	} );
} );

describe( 'reconcileTools — applyWikiSetRule', () => {
	it( 'disables add-wiki, remove-wiki, set-wiki when count is 1 and management is disallowed', () => {
		const { tools, mocks } = makeToolMap( true );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: false
		} );
		reconcileTools( tools );
		for ( const name of [ 'add-wiki', 'remove-wiki', 'set-wiki' ] ) {
			expect( mocks.get( name )!.disable ).toHaveBeenCalledTimes( 1 );
		}
	} );

	it( 'enables add-wiki only when count is 1 and management is allowed', () => {
		const { tools, mocks } = makeToolMap( false );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		expect( mocks.get( 'add-wiki' )!.enable ).toHaveBeenCalledTimes( 1 );
		expect( mocks.get( 'remove-wiki' )!.disable ).not.toHaveBeenCalled();
		expect( mocks.get( 'set-wiki' )!.disable ).not.toHaveBeenCalled();
	} );

	it( 'enables set-wiki when count is 2 even if management is disallowed', () => {
		const { tools, mocks } = makeToolMap( false );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: false
		} );
		reconcileTools( tools );
		expect( mocks.get( 'set-wiki' )!.enable ).toHaveBeenCalledTimes( 1 );
		expect( mocks.get( 'add-wiki' )!.enable ).not.toHaveBeenCalled();
		expect( mocks.get( 'remove-wiki' )!.enable ).not.toHaveBeenCalled();
	} );

	it( 'enables all three when count is 2 and management is allowed', () => {
		const { tools, mocks } = makeToolMap( false );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		for ( const name of [ 'add-wiki', 'remove-wiki', 'set-wiki' ] ) {
			expect( mocks.get( name )!.enable ).toHaveBeenCalledTimes( 1 );
		}
	} );

	it( 'transitions: count 1 to 2 enables set-wiki', () => {
		const { tools, mocks } = makeToolMap( false );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		expect( mocks.get( 'set-wiki' )!.enabled ).toBe( false );

		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		expect( mocks.get( 'set-wiki' )!.enabled ).toBe( true );
	} );

	it( 'transitions: count 2 to 1 disables remove-wiki', () => {
		const { tools, mocks } = makeToolMap( true );
		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki, b: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		expect( mocks.get( 'remove-wiki' )!.enabled ).toBe( true );

		setup( {
			activeWiki: baseWiki,
			wikis: { a: baseWiki },
			allowManagement: true
		} );
		reconcileTools( tools );
		expect( mocks.get( 'remove-wiki' )!.enabled ).toBe( false );
	} );
} );
