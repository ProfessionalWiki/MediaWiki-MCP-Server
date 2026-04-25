import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { formatPayload } from '../../src/common/formatPayload.js';

vi.mock( '../../src/common/mwn.js', () => ( { getMwn: vi.fn() } ) );
vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: {
				server: 'https://test.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				tags: null
			}
		} )
	}
} ) );

import { getMwn } from '../../src/common/mwn.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'undelete-page', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns a structured payload on success', async () => {
		const mock = createMockMwn( {
			undelete: vi.fn().mockResolvedValue( {
				title: 'Restored Page',
				reason: 'oops',
				revisions: 12
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Restored Page', 'oops' );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			title: 'Restored Page',
			restored: true,
			revisionCount: 12
		} ) );
		expect( mock.undelete ).toHaveBeenCalledWith(
			'Restored Page',
			expect.stringContaining( 'oops' ),
			expect.any( Object )
		);
	} );

	it( 'works without a revision count', async () => {
		const mock = createMockMwn( {
			undelete: vi.fn().mockResolvedValue( { title: 'Restored Page' } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Restored Page' );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Revision count:' );
	} );

	it( 'categorises permissiondenied as permission_denied with code', async () => {
		const mock = createMockMwn( {
			undelete: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Protected' );

		assertStructuredError( result, 'permission_denied', 'permissiondenied' );
	} );

	it( 'categorises generic upstream failures as upstream_failure', async () => {
		const mock = createMockMwn( {
			undelete: vi.fn().mockRejectedValue( new Error( 'Network down' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Some Page' );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch(
			/Failed to undelete page: Network down/
		);
	} );
} );
