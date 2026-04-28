import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getFile } from '../../src/tools/get-file.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { formatPayload } from '../../src/results/format.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'get-file', () => {
	it( 'returns file info using action=query&prop=imageinfo', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						title: 'File:Example.png',
						imageinfo: [ {
							url: 'https://test.wiki/images/example.png',
							descriptionurl: 'https://test.wiki/wiki/File:Example.png',
							size: 12345,
							width: 800,
							height: 600,
							mime: 'image/png',
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							thumburl: 'https://test.wiki/images/thumb/example.png/200px-example.png'
						} ]
					} ]
				}
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getFile.handle( { title: 'Example.png' }, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			title: 'File:Example.png',
			descriptionUrl: 'https://test.wiki/wiki/File:Example.png',
			timestamp: '2026-01-01T00:00:00Z',
			user: 'Admin',
			size: 12345,
			mime: 'image/png',
			url: 'https://test.wiki/images/example.png',
			thumbnailUrl: 'https://test.wiki/images/thumb/example.png/200px-example.png'
		} ) );
	} );

	it( 'handles missing files', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						title: 'File:Missing.png',
						missing: true
					} ]
				}
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getFile.handle( { title: 'Missing.png' }, ctx );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns error on API failure via dispatcher', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( getFile, ctx )( { title: 'Example.png' } );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );
} );
