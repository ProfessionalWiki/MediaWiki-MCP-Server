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

describe( 'get-recent-changes — formatter', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'renders an edit row with all optional fields', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Help:Foo',
				ns: 12,
				timestamp: '2026-01-01T12:34:56Z',
				user: 'Alice',
				userid: 42,
				revid: 1234567,
				old_revid: 1234500,
				newlen: 1523,
				oldlen: 1500,
				comment: 'typo fix',
				minor: true,
				bot: true,
				tags: [ 'mobile-edit' ],
				unpatrolled: true
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'Type: edit' );
		expect( text ).toContain( 'Title: Help:Foo' );
		expect( text ).toContain( 'Timestamp: 2026-01-01T12:34:56Z' );
		expect( text ).toContain( 'User: Alice (ID: 42)' );
		expect( text ).toContain( 'Revision: 1234567 (from 1234500)' );
		expect( text ).toContain( 'Size: 1523 bytes (+23)' );
		expect( text ).toContain( 'Comment: typo fix' );
		expect( text ).toContain( 'Flags: minor, bot' );
		expect( text ).toContain( 'Tags: mobile-edit' );
		expect( text ).toContain( 'Unpatrolled: yes' );
	} );

	it( 'omits Flags, Tags, Comment, and Unpatrolled lines when absent', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Foo',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Bob',
				userid: 7,
				revid: 100,
				old_revid: 99,
				newlen: 100,
				oldlen: 100,
				comment: '',
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).not.toContain( 'Flags:' );
		expect( text ).not.toContain( 'Tags:' );
		expect( text ).not.toContain( 'Comment:' );
		expect( text ).not.toContain( 'Unpatrolled:' );
		expect( text ).toContain( 'Size: 100 bytes (+0)' );
	} );

	it( 'renders a new-page row without the (from ...) suffix and with positive delta', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'new',
				title: 'Brand New',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Carol',
				userid: 3,
				revid: 500,
				old_revid: 0,
				newlen: 240,
				oldlen: 0,
				comment: 'created',
				new: true,
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'Type: new' );
		expect( text ).toContain( 'Revision: 500' );
		expect( text ).not.toContain( '(from' );
		expect( text ).toContain( 'Size: 240 bytes (+240)' );
		expect( text ).toContain( 'Flags: new' );
	} );

	it( 'renders a log row with Log line and logparams, no Revision or Size', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'log',
				title: 'User:BadActor',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Admin',
				userid: 1,
				comment: 'Vandalism-only account',
				logtype: 'block',
				logaction: 'block',
				logparams: { duration: 'infinity', flags: [ 'nocreate' ] },
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { types: [ 'log' ] } );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'Type: log' );
		expect( text ).toContain( 'Log: block/block (' );
		expect( text ).toContain( 'duration=infinity' );
		expect( text ).not.toContain( 'Revision:' );
		expect( text ).not.toContain( 'Size:' );
	} );

	it( 'renders a log row with no logparams as a bare Log line', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'log',
				title: 'Example',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Admin',
				userid: 1,
				comment: '',
				logtype: 'patrol',
				logaction: 'patrol',
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { types: [ 'log' ] } );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'Log: patrol/patrol' );
		expect( text ).not.toContain( 'Log: patrol/patrol (' );
	} );

	it( 'renders an anon edit as User: <IP> (anonymous)', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Foo',
				timestamp: '2026-01-01T00:00:00Z',
				user: '192.0.2.1',
				anon: true,
				revid: 100,
				old_revid: 99,
				newlen: 100,
				oldlen: 90,
				comment: '',
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'User: 192.0.2.1 (anonymous)' );
		expect( text ).not.toContain( '(ID:' );
		expect( text ).toContain( 'Flags: anon' );
	} );

	it( 'renders hidden user as User: (hidden) and drops hidden comment line', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Foo',
				timestamp: '2026-01-01T00:00:00Z',
				userhidden: true,
				commenthidden: true,
				revid: 100,
				old_revid: 99,
				newlen: 100,
				oldlen: 90,
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).toContain( 'User: (hidden)' );
		expect( text ).not.toContain( 'Comment:' );
	} );

	it( 'omits the Unpatrolled line for patrolled edits', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Foo',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Alice',
				userid: 42,
				revid: 100,
				old_revid: 99,
				newlen: 100,
				oldlen: 90,
				comment: '',
				patrolled: true,
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const text = ( result.content[ 0 ] as { text: string } ).text;
		expect( text ).not.toContain( 'Unpatrolled' );
	} );
} );
