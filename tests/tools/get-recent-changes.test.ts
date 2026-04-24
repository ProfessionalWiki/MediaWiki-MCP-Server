import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( { getMwn: vi.fn() } ) );
vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );

import { getMwn } from '../../src/common/mwn.js';

const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo|patrolled';

function mockRequest( response: unknown ) {
	const mock = createMockMwn( {
		request: vi.fn().mockResolvedValue( response )
	} );
	vi.mocked( getMwn ).mockResolvedValue( mock as any );
	return mock;
}

describe( 'get-recent-changes — parameter mapping', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'issues a default query with rctype=edit|new, rclimit=50, rcdir=older, full rcprop', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( {} );

		expect( mock.request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'query',
			list: 'recentchanges',
			rctype: 'edit|new',
			rclimit: 50,
			rcdir: 'older',
			rcprop: RC_PROP,
			formatversion: '2'
		} ) );
	} );

	it( 'maps since to rcend and until to rcstart (rcdir=older walks rcstart→rcend)', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { since: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' } );

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( {
			rcend: '2026-01-01T00:00:00Z',
			rcstart: '2026-02-01T00:00:00Z'
		} );
	} );

	it( 'pipe-joins namespace array into rcnamespace', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { namespace: [ 0, 1, 14 ] } );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcnamespace ).toBe( '0|1|14' );
	} );

	it( 'pipe-joins types array into rctype', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { types: [ 'log', 'categorize' ] } );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rctype ).toBe( 'log|categorize' );
	} );

	it( 'maps user and tag through to rcuser and rctag', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { user: 'Alice', tag: 'mobile-edit' } );

		expect( mock.request.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
			rcuser: 'Alice',
			rctag: 'mobile-edit'
		} );
	} );

	it( 'maps excludeUser to rcexcludeuser', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { excludeUser: 'Bob' } );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcexcludeuser ).toBe( 'Bob' );
	} );

	it( 'composes hide flags into a pipe-joined rcshow', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( {
			hideBots: true, hideMinor: true, hideAnon: true,
			hideRedirects: false, hidePatrolled: false
		} );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcshow ).toBe( '!bot|!minor|!anon' );
	} );

	it( 'omits rcshow when no hide flags are set', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( {} );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcshow ).toBeUndefined();
	} );

	it( 'maps continue token to rccontinue', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( { continue: '20260101123456|1234567' } );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rccontinue ).toBe( '20260101123456|1234567' );
	} );
} );

describe( 'get-recent-changes — handler validation', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'rejects user + excludeUser combined without issuing an API call', async () => {
		const mock = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { user: 'Alice', excludeUser: 'Bob' } );

		expect( result.isError ).toBe( true );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain(
			'Cannot use both user and excludeUser at the same time'
		);
		expect( mock.request ).not.toHaveBeenCalled();
	} );
} );

describe( 'get-recent-changes — error handling', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'surfaces API errors as isError with a wrapped message', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'badtimestamp' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { since: 'garbage' } );

		expect( result.isError ).toBe( true );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toContain(
			'Failed to retrieve recent changes: badtimestamp'
		);
	} );
} );
