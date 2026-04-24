import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { TruncationSchema } from '../../src/common/schemas.js';

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
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo';

const RecentChangeSchema = z.object( {
	type: z.enum( [ 'edit', 'new', 'log', 'categorize', 'external' ] ),
	title: z.string(),
	timestamp: z.string(),
	user: z.string().optional(),
	userid: z.number().int().nonnegative().optional(),
	anon: z.boolean().optional(),
	userhidden: z.boolean().optional(),
	commenthidden: z.boolean().optional(),
	revid: z.number().int().nonnegative().optional(),
	oldRevid: z.number().int().nonnegative().optional(),
	newlen: z.number().int().nonnegative().optional(),
	oldlen: z.number().int().nonnegative().optional(),
	sizeDelta: z.number().int().optional(),
	comment: z.string().optional(),
	minor: z.boolean().optional(),
	bot: z.boolean().optional(),
	isNew: z.boolean().optional(),
	redirect: z.boolean().optional(),
	unpatrolled: z.boolean().optional(),
	tags: z.array( z.string() ).optional(),
	logtype: z.string().optional(),
	logaction: z.string().optional(),
	logparams: z.record( z.string(), z.unknown() ).optional()
} );

const RecentChangesSchema = z.object( {
	changes: z.array( RecentChangeSchema ),
	truncation: TruncationSchema.optional()
} );

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

	it( 'appends patrolled to rcprop only when showPatrolStatus is set', async () => {
		const mockOff = mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		await handleGetRecentChangesTool( {} );
		expect( mockOff.request.mock.calls[ 0 ][ 0 ].rcprop ).toBe( RC_PROP );

		const mockOn = mockRequest( { query: { recentchanges: [] } } );
		await handleGetRecentChangesTool( { showPatrolStatus: true } );
		expect( mockOn.request.mock.calls[ 0 ][ 0 ].rcprop ).toBe( `${ RC_PROP }|patrolled` );
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

		assertStructuredError( result, 'invalid_input' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain(
			'user and excludeUser are mutually exclusive'
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

		assertStructuredError( result, 'upstream_failure' );
		expect( ( result.structuredContent as { message: string } ).message ).toContain(
			'Failed to retrieve recent changes: badtimestamp'
		);
	} );
} );

describe( 'get-recent-changes — payload shape', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'emits a full edit row with sizeDelta computed server-side', async () => {
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
				tags: [ 'mobile-edit' ]
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes ).toHaveLength( 1 );
		expect( data.changes[ 0 ] ).toMatchObject( {
			type: 'edit',
			title: 'Help:Foo',
			timestamp: '2026-01-01T12:34:56Z',
			user: 'Alice',
			userid: 42,
			revid: 1234567,
			oldRevid: 1234500,
			newlen: 1523,
			oldlen: 1500,
			sizeDelta: 23,
			comment: 'typo fix',
			minor: true,
			bot: true,
			tags: [ 'mobile-edit' ]
		} );
	} );

	it( 'renders a new-page row with isNew=true and a positive sizeDelta', async () => {
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

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ] ).toMatchObject( {
			type: 'new',
			revid: 500,
			oldRevid: 0,
			sizeDelta: 240,
			isNew: true
		} );
	} );

	it( 'renders a log row with logtype, logaction and logparams preserved', async () => {
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

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ] ).toMatchObject( {
			type: 'log',
			logtype: 'block',
			logaction: 'block',
			logparams: { duration: 'infinity', flags: [ 'nocreate' ] }
		} );
		expect( data.changes[ 0 ].revid ).toBeUndefined();
	} );

	it( 'preserves anon flag on anonymous edits', async () => {
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

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ].user ).toBe( '192.0.2.1' );
		expect( data.changes[ 0 ].anon ).toBe( true );
		expect( data.changes[ 0 ].userid ).toBeUndefined();
	} );

	it( 'drops comment when commenthidden is set and preserves userhidden', async () => {
		mockRequest( {
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
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ].userhidden ).toBe( true );
		expect( data.changes[ 0 ].commenthidden ).toBe( true );
		expect( data.changes[ 0 ].comment ).toBeUndefined();
	} );

	it( 'preserves unpatrolled when set on the row', async () => {
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
				tags: [],
				unpatrolled: true
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { showPatrolStatus: true } );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ].unpatrolled ).toBe( true );
	} );

	it( 'omits unpatrolled when not set on the row', async () => {
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
				tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( { showPatrolStatus: true } );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes[ 0 ].unpatrolled ).toBeUndefined();
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
		mockRequest( {
			query: { recentchanges: rows },
			continue: { rccontinue: '20260101000000|1234', continue: '-||' }
		} );

		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.truncation ).toEqual( {
			reason: 'more-available',
			returnedCount: 2,
			itemNoun: 'changes',
			toolName: 'get-recent-changes',
			continueWith: { param: 'continue', value: '20260101000000|1234' }
		} );
	} );

	it( 'omits truncation when rccontinue is absent', async () => {
		mockRequest( {
			query: { recentchanges: [ {
				type: 'edit', title: 'Foo', timestamp: '2026-01-01T00:00:00Z',
				user: 'A', userid: 1, revid: 100, old_revid: 99,
				newlen: 100, oldlen: 100, comment: '', tags: []
			} ] }
		} );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.truncation ).toBeUndefined();
	} );

	it( 'returns an empty changes array when no matches', async () => {
		mockRequest( { query: { recentchanges: [] } } );
		const { handleGetRecentChangesTool } = await import( '../../src/tools/get-recent-changes.js' );
		const result = await handleGetRecentChangesTool( {} );

		const data = assertStructuredSuccess( result, RecentChangesSchema );
		expect( data.changes ).toEqual( [] );
		expect( data.truncation ).toBeUndefined();
	} );
} );
