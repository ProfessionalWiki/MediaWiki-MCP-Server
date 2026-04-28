import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn, type MockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import type { ToolContext } from '../../src/runtime/context.js';
import { getRecentChanges } from '../../src/tools/get-recent-changes.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo';

function setup( response: unknown ): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn( {
		request: vi.fn().mockResolvedValue( response )
	} );
	const ctx = fakeContext( { mwn: async () => mock as never } );
	return { mock, ctx };
}

describe( 'get-recent-changes — parameter mapping', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'issues a default query with rctype=edit|new, rclimit=50, rcdir=older, full rcprop', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( {}, ctx );

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
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle(
			{ since: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' },
			ctx
		);

		const call = mock.request.mock.calls[ 0 ][ 0 ];
		expect( call ).toMatchObject( {
			rcend: '2026-01-01T00:00:00Z',
			rcstart: '2026-02-01T00:00:00Z'
		} );
	} );

	it( 'pipe-joins namespace array into rcnamespace', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { namespace: [ 0, 1, 14 ] }, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcnamespace ).toBe( '0|1|14' );
	} );

	it( 'pipe-joins types array into rctype', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { types: [ 'log', 'categorize' ] }, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rctype ).toBe( 'log|categorize' );
	} );

	it( 'maps user and tag through to rcuser and rctag', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { user: 'Alice', tag: 'mobile-edit' }, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ] ).toMatchObject( {
			rcuser: 'Alice',
			rctag: 'mobile-edit'
		} );
	} );

	it( 'maps excludeUser to rcexcludeuser', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { excludeUser: 'Bob' }, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcexcludeuser ).toBe( 'Bob' );
	} );

	it( 'composes hide flags into a pipe-joined rcshow', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( {
			hideBots: true, hideMinor: true, hideAnon: true,
			hideRedirects: false, hidePatrolled: false
		}, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcshow ).toBe( '!bot|!minor|!anon' );
	} );

	it( 'omits rcshow when no hide flags are set', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( {}, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rcshow ).toBeUndefined();
	} );

	it( 'appends patrolled to rcprop only when showPatrolStatus is set', async () => {
		const off = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( {}, off.ctx );
		expect( off.mock.request.mock.calls[ 0 ][ 0 ].rcprop ).toBe( RC_PROP );

		const on = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { showPatrolStatus: true }, on.ctx );
		expect( on.mock.request.mock.calls[ 0 ][ 0 ].rcprop ).toBe( `${ RC_PROP }|patrolled` );
	} );

	it( 'maps continue token to rccontinue', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		await getRecentChanges.handle( { continue: '20260101123456|1234567' }, ctx );

		expect( mock.request.mock.calls[ 0 ][ 0 ].rccontinue ).toBe( '20260101123456|1234567' );
	} );
} );

describe( 'get-recent-changes — handler validation', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'rejects user + excludeUser combined without issuing an API call', async () => {
		const { mock, ctx } = setup( { query: { recentchanges: [] } } );
		const result = await getRecentChanges.handle(
			{ user: 'Alice', excludeUser: 'Bob' },
			ctx
		);

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toContain(
			'user and excludeUser are mutually exclusive'
		);
		expect( mock.request ).not.toHaveBeenCalled();
	} );
} );

describe( 'get-recent-changes — error handling', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'surfaces API errors as isError with a wrapped message via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'badtimestamp' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( getRecentChanges, ctx )( { since: 'garbage' } );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain(
			'Failed to retrieve recent changes: badtimestamp'
		);
	} );
} );

describe( 'get-recent-changes — payload shape', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'emits a full edit row with sizeDelta computed server-side', async () => {
		const { ctx } = setup( {
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
				tags: [ 'mobile-edit' ]
			} ] }
		} );
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		const titles = ( text.match( /Title: /g ) ?? [] );
		expect( titles ).toHaveLength( 1 );
		expect( text ).toContain( 'Type: edit' );
		expect( text ).toContain( 'Title: Help:Foo' );
		expect( text ).toContain( 'Timestamp: 2026-01-01T12:34:56Z' );
		expect( text ).toContain( 'User: Alice' );
		expect( text ).toContain( 'Userid: 42' );
		expect( text ).toContain( 'Revision ID: 1234567' );
		expect( text ).toContain( 'Old revision ID: 1234500' );
		expect( text ).toContain( 'Newlen: 1523' );
		expect( text ).toContain( 'Oldlen: 1500' );
		expect( text ).toContain( 'Size delta: 23' );
		expect( text ).toContain( 'Comment: typo fix' );
		expect( text ).toContain( 'Minor: true' );
		expect( text ).toContain( 'Bot: true' );
		expect( text ).toContain( 'Tags:\n  - mobile-edit' );
		// Above asserts the array is rendered indented under the entry.
	} );

	it( 'renders a new-page row with isNew=true and a positive sizeDelta', async () => {
		const { ctx } = setup( {
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
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Type: new' );
		expect( text ).toContain( 'Revision ID: 500' );
		expect( text ).toContain( 'Old revision ID: 0' );
		expect( text ).toContain( 'Size delta: 240' );
		expect( text ).toContain( 'Is new: true' );
	} );

	it( 'renders a log row with logtype, logaction and logparams preserved', async () => {
		const { ctx } = setup( {
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
		const result = await getRecentChanges.handle( { types: [ 'log' ] }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Type: log' );
		expect( text ).toContain( 'Logtype: block' );
		expect( text ).toContain( 'Logaction: block' );
		expect( text ).toContain( 'Logparams:' );
		expect( text ).toContain( '    Duration: infinity' );
		expect( text ).toContain( '    Flags:' );
		expect( text ).toContain( '    - nocreate' );
		expect( text ).not.toContain( 'Revision ID:' );
	} );

	it( 'preserves anon flag on anonymous edits', async () => {
		const { ctx } = setup( {
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
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'User: 192.0.2.1' );
		expect( text ).toContain( 'Anon: true' );
		expect( text ).not.toContain( 'Userid:' );
	} );

	it( 'drops comment when commenthidden is set and preserves userhidden', async () => {
		const { ctx } = setup( {
			query: { recentchanges: [ {
				type: 'edit',
				title: 'Foo',
				timestamp: '2026-01-01T00:00:00Z',
				userhidden: true,
				commenthidden: true,
				comment: 'this should be dropped',
				revid: 100,
				old_revid: 99,
				newlen: 100,
				oldlen: 90,
				tags: []
			} ] }
		} );
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Userhidden: true' );
		expect( text ).toContain( 'Commenthidden: true' );
		expect( text ).not.toContain( 'Comment:' );
	} );

	it( 'preserves unpatrolled when set on the row', async () => {
		const { ctx } = setup( {
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
				tags: [],
				unpatrolled: true
			} ] }
		} );
		const result = await getRecentChanges.handle( { showPatrolStatus: true }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Unpatrolled: true' );
	} );

	it( 'omits unpatrolled when not set on the row', async () => {
		const { ctx } = setup( {
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
				tags: []
			} ] }
		} );
		const result = await getRecentChanges.handle( { showPatrolStatus: true }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Unpatrolled:' );
	} );
} );

describe( 'get-recent-changes — truncation and empty results', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'attaches a more-available truncation when rccontinue is present', async () => {
		const rows = Array.from( { length: 2 }, ( _, i ) => ( {
			type: 'edit',
			title: `Page ${ i }`,
			timestamp: '2026-01-01T00:00:00Z',
			user: 'Alice',
			userid: 42,
			revid: 100 + i,
			old_revid: 99 + i,
			newlen: 100,
			oldlen: 100,
			comment: '',
			tags: []
		} ) );
		const { ctx } = setup( {
			query: { recentchanges: rows },
			continue: { rccontinue: '20260101000000|1234', continue: '-||' }
		} );

		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: more-available' );
		expect( text ).toContain( '  Returned count: 2' );
		expect( text ).toContain( '  Item noun: changes' );
		expect( text ).toContain( '  Tool name: get-recent-changes' );
		expect( text ).toContain( '  Continue with:' );
		expect( text ).toContain( '    Param: continue' );
		expect( text ).toContain( '    Value: 20260101000000|1234' );
	} );

	it( 'omits truncation when rccontinue is absent', async () => {
		const { ctx } = setup( {
			query: { recentchanges: [ {
				type: 'edit', title: 'Foo', timestamp: '2026-01-01T00:00:00Z',
				user: 'A', userid: 1, revid: 100, old_revid: 99,
				newlen: 100, oldlen: 100, comment: '', tags: []
			} ] }
		} );
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'returns an empty changes array when no matches', async () => {
		const { ctx } = setup( { query: { recentchanges: [] } } );
		const result = await getRecentChanges.handle( {}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Changes: (none)' );
		expect( text ).not.toContain( 'Truncation:' );
	} );
} );
