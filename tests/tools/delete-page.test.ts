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

describe( 'delete-page', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns a structured payload on success', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockResolvedValue( {
				title: 'Old Page',
				reason: 'spam',
				logid: 42
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleDeletePageTool } = await import( '../../src/tools/delete-page.js' );
		const result = await handleDeletePageTool( 'Old Page', 'spam' );

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
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleDeletePageTool } = await import( '../../src/tools/delete-page.js' );
		const result = await handleDeletePageTool( 'Old Page' );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Log ID:' );
	} );

	it( 'categorises missingtitle as not_found with code', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockRejectedValue( createMockMwnError( 'missingtitle' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleDeletePageTool } = await import( '../../src/tools/delete-page.js' );
		const result = await handleDeletePageTool( 'Nonexistent' );

		assertStructuredError( result, 'not_found', 'missingtitle' );
	} );

	it( 'categorises permissiondenied as permission_denied with code', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleDeletePageTool } = await import( '../../src/tools/delete-page.js' );
		const result = await handleDeletePageTool( 'Protected' );

		assertStructuredError( result, 'permission_denied', 'permissiondenied' );
	} );
} );
