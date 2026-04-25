import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
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
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'get-revision', () => {
	beforeEach( () => { vi.clearAllMocks(); } );

	it( 'returns source content from a specific revision', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Test Page',
						revisions: [ {
							revid: 42,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'edit',
							size: 500,
							minor: false,
							content: 'Hello world'
						} ]
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'source', false );

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Source: Hello world' );
		expect( text ).toContain( 'Revision ID: 42' );
		expect( text ).toContain( 'Title: Test Page' );
		expect( text ).not.toContain( 'User:' );
	} );

	it( 'returns HTML content using action=parse', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>' }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'html', false );

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
		expect( text ).toContain( 'Revision ID: 42' );
	} );

	it( 'returns metadata with minor edit flag', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Test Page',
						revisions: [ {
							revid: 42,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'minor fix',
							size: 500,
							minor: true
						} ]
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'none', true );

		const text = assertStructuredSuccess( result, z.string() );
		expect( text ).toContain( 'Minor: true' );
		expect( text ).toMatch( /URL: .*Test_Page/ );
		expect( text ).not.toContain( 'Source:' );
		expect( text ).not.toContain( 'HTML:' );
	} );

	it( 'returns error when revision is not found', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 0,
						title: '',
						missing: true
					} ]
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 99999, 'source', false );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns error on failure', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleGetRevisionTool } = await import( '../../src/tools/get-revision.js' );
		const result = await handleGetRevisionTool( 42, 'source', false );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
