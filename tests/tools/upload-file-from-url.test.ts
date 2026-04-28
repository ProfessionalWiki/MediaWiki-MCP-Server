import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { uploadFileFromUrl } from '../../src/tools/upload-file-from-url.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'upload-file-from-url', () => {
	it( 'returns a structured payload on success', async () => {
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

		const result = await uploadFileFromUrl.handle( {
			url: 'https://source.example/cat.jpg',
			title: 'File:Cat.jpg',
			text: 'A cat.'
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Filename: Cat.jpg' );
		expect( text ).toContain( 'Page URL: https://test.wiki/wiki/File:Cat.jpg' );
		expect( text ).toContain( 'File URL: https://test.wiki/images/Cat.jpg' );
	} );

	it( 'surfaces copyuploaddisabled as invalid_input with a remedy hint', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue(
				createMockMwnError(
					'copyuploaddisabled',
					'copyuploaddisabled: Uploads by URL are disabled on this wiki.'
				)
			)
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await uploadFileFromUrl.handle( {
			url: 'https://source.example/cat.jpg',
			title: 'File:Cat.jpg',
			text: 'A cat.'
		}, ctx );

		const envelope = assertStructuredError( result, 'invalid_input', 'copyuploaddisabled' );
		expect( envelope.message ).toMatch( /Upload by URL is disabled/ );
	} );

	it( 'dispatches generic upstream failures with the standard verb prefix', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( new Error( 'Connection refused' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( uploadFileFromUrl, ctx )( {
			url: 'https://source.example/cat.jpg',
			title: 'File:Cat.jpg',
			text: 'A cat.'
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch( /Failed to upload file: Connection refused/ );
	} );

	it( 'forwards configured tags via ctx.edit.applyTags', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg'
			} )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: ( o: object ) => ( { ...o, tags: 'mcp-server' } )
			}
		} );

		await uploadFileFromUrl.handle( {
			url: 'https://source.example/cat.jpg',
			title: 'File:Cat.jpg',
			text: 'A cat.'
		}, ctx );

		const params = mock.uploadFromUrl.mock.calls[ 0 ][ 3 ];
		expect( params ).toHaveProperty( 'tags', 'mcp-server' );
	} );
} );
