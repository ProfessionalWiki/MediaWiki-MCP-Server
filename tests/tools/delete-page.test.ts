import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { deletePage } from '../../src/tools/delete-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { formatPayload } from '../../src/results/format.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'delete-page', () => {
	it( 'returns a structured payload on success', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockResolvedValue( {
				title: 'Old Page',
				reason: 'spam',
				logid: 42
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await deletePage.handle(
			{ title: 'Old Page', comment: 'spam' },
			ctx
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			title: 'Old Page',
			deleted: true,
			logId: 42
		} ) );
		expect( mock.delete ).toHaveBeenCalledWith(
			'Old Page',
			expect.stringContaining( 'spam' ),
			expect.any( Object )
		);
	} );

	it( 'works without a logid in the response', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockResolvedValue( { title: 'Old Page' } )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await deletePage.handle( { title: 'Old Page' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Log ID:' );
	} );

	it( 'dispatches missingtitle as not_found via dispatcher', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockRejectedValue( createMockMwnError( 'missingtitle' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( deletePage, ctx )( { title: 'Nonexistent' } );

		assertStructuredError( result, 'not_found', 'missingtitle' );
	} );

	it( 'dispatches permissiondenied as permission_denied via dispatcher', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( deletePage, ctx )( { title: 'Protected' } );

		assertStructuredError( result, 'permission_denied', 'permissiondenied' );
	} );

	it( 'injects tags from selection when configured', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockResolvedValue( { title: 'X' } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: ( o: object ) => ( { ...o, tags: 'mcp-edit' } )
			}
		} );

		await deletePage.handle( { title: 'X' }, ctx );

		expect( mock.delete ).toHaveBeenCalledWith(
			'X',
			expect.any( String ),
			{ tags: 'mcp-edit' }
		);
	} );
} );
