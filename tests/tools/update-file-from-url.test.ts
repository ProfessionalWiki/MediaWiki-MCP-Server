import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';

vi.mock( '../../src/transport/fileExistence.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/transport/fileExistence.js' )>(
		'../../src/transport/fileExistence.js'
	);
	return {
		...actual,
		assertFileExists: vi.fn()
	};
} );

import { assertFileExists, FileNotFoundError } from '../../src/transport/fileExistence.js';
import { updateFileFromUrl } from '../../src/tools/update-file-from-url.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'update-file-from-url', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns not_found with routing hint when the file does not exist', async () => {
		vi.mocked( assertFileExists ).mockRejectedValue( new FileNotFoundError( 'Cat.jpg' ) );
		const mock = createMockMwn( { uploadFromUrl: vi.fn() } );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await updateFileFromUrl.handle( {
			url: 'https://example.com/cat.jpg',
			title: 'Cat.jpg'
		}, ctx );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toMatch( /Cat\.jpg/ );
		expect( envelope.message ).toMatch( /upload-file-from-url\b/ );
		expect( mock.uploadFromUrl ).not.toHaveBeenCalled();
	} );

	it( 'calls mwn.uploadFromUrl with ignorewarnings: true and the formatted comment', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		await updateFileFromUrl.handle( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg',
			comment: 'Higher resolution'
		}, ctx );

		expect( mock.uploadFromUrl ).toHaveBeenCalledWith(
			'https://example.com/cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining( {
				ignorewarnings: true,
				comment: expect.stringMatching( /^Higher resolution.*update-file-from-url/ )
			} )
		);
	} );

	it( 'returns the same structured payload as upload-file-from-url on success', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await updateFileFromUrl.handle( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg'
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Filename: Cat.jpg' );
		expect( text ).toContain( 'Page URL: https://test.wiki/wiki/File:Cat.jpg' );
		expect( text ).toContain( 'File URL: https://test.wiki/images/Cat.jpg' );
	} );

	it( 'maps copyuploaddisabled errors to invalid_input with the routing hint', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue(
				new Error( 'copyuploaddisabled: Upload by URL is disabled on this wiki.' )
			)
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await updateFileFromUrl.handle( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg'
		}, ctx );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.code ).toBe( 'copyuploaddisabled' );
		expect( envelope.message ).toMatch( /Download the file locally.*update-file\b/ );
	} );

	it( 'dispatches generic upload errors with the standard verb prefix', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( new Error( 'Boom' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( updateFileFromUrl, ctx )( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg'
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch( /Failed to update file: Boom/ );
	} );

	it( 'maps permissiondenied-coded errors to permission_denied', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const err = Object.assign( new Error( 'You cannot reupload' ), { code: 'permissiondenied' } );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( err )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( updateFileFromUrl, ctx )( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg'
		} );

		assertStructuredError( result, 'permission_denied' );
	} );

	it( 'forwards configured tags via ctx.edit.applyTags', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( { result: 'Success', filename: 'Cat.jpg' } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: ( o: object ) => ( { ...o, tags: 'mcp-server' } )
			}
		} );

		await updateFileFromUrl.handle( {
			url: 'https://example.com/cat.jpg',
			title: 'File:Cat.jpg'
		}, ctx );

		const params = mock.uploadFromUrl.mock.calls[ 0 ][ 3 ];
		expect( params ).toHaveProperty( 'tags', 'mcp-server' );
	} );
} );
