import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getRevision } from '../../src/tools/get-revision.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { ContentFormat } from '../../src/common/contentFormat.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'get-revision', () => {
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.source, metadata: false },
			ctx
		);

		const text = assertStructuredSuccess( result );
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.html, metadata: false },
			ctx
		);

		const text = assertStructuredSuccess( result );
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getRevision.handle(
			{ revisionId: 42, content: ContentFormat.none, metadata: true },
			ctx
		);

		const text = assertStructuredSuccess( result );
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
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getRevision.handle(
			{ revisionId: 99999, content: ContentFormat.source, metadata: false },
			ctx
		);

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns error on failure via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( getRevision, ctx )( {
			revisionId: 42,
			content: ContentFormat.source,
			metadata: false
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
