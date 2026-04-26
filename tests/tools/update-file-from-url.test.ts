import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn()
} ) );

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );

vi.mock( '../../src/common/fileExistence.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/fileExistence.js' )>(
		'../../src/common/fileExistence.js'
	);
	return {
		...actual,
		assertFileExists: vi.fn()
	};
} );

import { getMwn } from '../../src/common/mwn.js';
import { assertFileExists, FileNotFoundError } from '../../src/common/fileExistence.js';
import { formatPayload } from '../../src/common/formatPayload.js';
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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'Cat.jpg'
		);

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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg',
			'Higher resolution'
		);

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
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg'
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			filename: 'Cat.jpg',
			pageUrl: 'https://test.wiki/wiki/File:Cat.jpg',
			fileUrl: 'https://test.wiki/images/Cat.jpg'
		} ) );
	} );

	it( 'maps copyuploaddisabled errors to invalid_input with the routing hint', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue(
				new Error( 'copyuploaddisabled: Upload by URL is disabled on this wiki.' )
			)
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg'
		);

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.code ).toBe( 'copyuploaddisabled' );
		expect( envelope.message ).toMatch( /Download the file locally.*update-file\b/ );
	} );

	it( 'maps generic upload errors to upstream_failure', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( new Error( 'Boom' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg'
		);

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch( /Failed to update file: Boom/ );
	} );

	it( 'maps permissiondenied-coded errors to permission_denied', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const err = Object.assign( new Error( 'You cannot reupload' ), { code: 'permissiondenied' } );
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( err )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileFromUrlTool } = await import(
			'../../src/tools/update-file-from-url.js'
		);
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg'
		);

		assertStructuredError( result, 'permission_denied' );
	} );
} );
