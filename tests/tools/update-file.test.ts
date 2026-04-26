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
		} ),
		getUploadDirs: vi.fn().mockReturnValue( [ '/home/user/uploads' ] )
	}
} ) );

vi.mock( '../../src/common/uploadGuard.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/uploadGuard.js' )>(
		'../../src/common/uploadGuard.js'
	);
	return {
		...actual,
		assertAllowedPath: vi.fn()
	};
} );

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
import { assertAllowedPath, UploadValidationError } from '../../src/common/uploadGuard.js';
import { assertFileExists, FileNotFoundError } from '../../src/common/fileExistence.js';
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'update-file', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns invalid_input for UploadValidationError, skips pre-flight and upload', async () => {
		vi.mocked( assertAllowedPath ).mockRejectedValue(
			new UploadValidationError( '"/etc/passwd" is not allowed' )
		);
		const mock = createMockMwn( { upload: vi.fn() } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool( '/etc/passwd', 'File:Shadow' );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toMatch( /Failed to update file:.*not allowed/ );
		expect( assertFileExists ).not.toHaveBeenCalled();
		expect( mock.upload ).not.toHaveBeenCalled();
	} );

	it( 'returns upstream_failure for unexpected guard errors, skips upload', async () => {
		vi.mocked( assertAllowedPath ).mockRejectedValue( new Error( 'Connection refused' ) );
		const mock = createMockMwn( { upload: vi.fn() } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool( '/home/user/uploads/x.jpg', 'File:X' );

		assertStructuredError( result, 'upstream_failure' );
		expect( mock.upload ).not.toHaveBeenCalled();
	} );

	it( 'returns not_found with routing hint when the file does not exist', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockRejectedValue( new FileNotFoundError( 'Cat.jpg' ) );
		const mock = createMockMwn( { upload: vi.fn() } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool( '/home/user/uploads/cat.jpg', 'Cat.jpg' );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toMatch( /Cat\.jpg/ );
		expect( envelope.message ).toMatch( /upload-file\b/ );
		expect( mock.upload ).not.toHaveBeenCalled();
	} );

	it( 'calls mwn.upload with ignorewarnings: true and the formatted comment', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			upload: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		await handleUpdateFileTool( '/home/user/uploads/cat.jpg', 'File:Cat.jpg', 'New colour pass' );

		expect( mock.upload ).toHaveBeenCalledWith(
			'/var/lib/uploads/cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining( {
				ignorewarnings: true,
				comment: expect.stringMatching( /^New colour pass.*update-file/ )
			} )
		);
	} );

	it( 'returns the same structured payload as upload-file on success', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			upload: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg'
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			filename: 'Cat.jpg',
			pageUrl: 'https://test.wiki/wiki/File:Cat.jpg',
			fileUrl: 'https://test.wiki/images/Cat.jpg'
		} ) );
	} );

	it( 'maps generic mwn.upload errors to upstream_failure', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			upload: vi.fn().mockRejectedValue( new Error( 'Boom' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg'
		);

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch( /Failed to update file: Boom/ );
	} );

	it( 'maps permissiondenied-coded errors to permission_denied', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const err = Object.assign( new Error( 'You cannot reupload' ), { code: 'permissiondenied' } );
		const mock = createMockMwn( {
			upload: vi.fn().mockRejectedValue( err )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg'
		);

		assertStructuredError( result, 'permission_denied' );
	} );

	it( 'forwards the configured uploadDirs allowlist to the path guard', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/x.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		const mock = createMockMwn( {
			upload: vi.fn().mockResolvedValue( { result: 'Success' } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		await handleUpdateFileTool( '/home/user/uploads/x.jpg', 'File:X' );

		expect( assertAllowedPath ).toHaveBeenCalledWith(
			'/home/user/uploads/x.jpg',
			[ '/home/user/uploads' ]
		);
	} );
} );
