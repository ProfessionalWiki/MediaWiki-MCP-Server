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

vi.mock( '../../src/common/uploadGuard.js', () => ( {
	assertAllowedPath: vi.fn()
} ) );

import { getMwn } from '../../src/common/mwn.js';
import { wikiService } from '../../src/common/wikiService.js';
import { assertAllowedPath } from '../../src/common/uploadGuard.js';

describe( 'upload-file', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		vi.mocked( wikiService.getUploadDirs ).mockReturnValue( [ '/home/user/uploads' ] );
	} );

	it( 'returns isError and does not call mwn.upload when the guard rejects the filepath', async () => {
		vi.mocked( assertAllowedPath ).mockRejectedValue(
			new Error( 'Upload rejected: "/etc/passwd" is not allowed by the configured upload directories.' )
		);
		const mock = createMockMwn( { upload: vi.fn() } );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUploadFileTool } = await import( '../../src/tools/upload-file.js' );
		const result = await handleUploadFileTool( '/etc/passwd', 'File:Shadow', 'body' );

		expect( result.isError ).toBe( true );
		expect( ( result.content[ 0 ] as { text: string } ).text ).toMatch( /Upload rejected/ );
		expect( mock.upload ).not.toHaveBeenCalled();
	} );

	it( 'passes the realpath-resolved filepath to mwn.upload on success', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/var/lib/uploads/cat.jpg' );
		const mock = createMockMwn( {
			upload: vi.fn().mockResolvedValue( { result: 'Success', filename: 'Cat.jpg' } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUploadFileTool } = await import( '../../src/tools/upload-file.js' );
		const result = await handleUploadFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);

		expect( result.isError ).toBeUndefined();
		expect( mock.upload ).toHaveBeenCalledWith(
			'/var/lib/uploads/cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			expect.any( Object )
		);
	} );

	it( 'passes the configured uploadDirs allowlist to the guard', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/x.jpg' );
		const mock = createMockMwn( {
			upload: vi.fn().mockResolvedValue( { result: 'Success' } )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { handleUploadFileTool } = await import( '../../src/tools/upload-file.js' );
		await handleUploadFileTool( '/home/user/uploads/x.jpg', 'File:X', 'body' );

		expect( assertAllowedPath ).toHaveBeenCalledWith(
			'/home/user/uploads/x.jpg',
			[ '/home/user/uploads' ]
		);
	} );
} );
