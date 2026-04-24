import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( 'node:fs/promises', () => ( {
	realpath: vi.fn()
} ) );

import { realpath } from 'node:fs/promises';
import { assertAllowedPath } from '../../src/common/uploadGuard.js';

describe( 'uploadGuard.assertAllowedPath', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'rejects when allowedDirs is empty', async () => {
		await expect(
			assertAllowedPath( '/home/user/file.jpg', [] )
		).rejects.toThrow( /MCP_UPLOAD_DIRS|uploadDirs/ );
	} );

	it( 'rejects a relative filepath', async () => {
		await expect(
			assertAllowedPath( 'relative/file.jpg', [ '/home/user/uploads' ] )
		).rejects.toThrow( /absolute path/ );
	} );

	it( 'rejects a non-existent filepath with a clear message', async () => {
		vi.mocked( realpath ).mockRejectedValueOnce(
			Object.assign( new Error( 'ENOENT: no such file' ), { code: 'ENOENT' } )
		);
		await expect(
			assertAllowedPath( '/home/user/missing.jpg', [ '/home/user/uploads' ] )
		).rejects.toThrow( /file not found/i );
	} );

	it( 'accepts and returns the canonical path for a file inside an allowed dir', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/home/user/uploads/cat.jpg' );
		const resolved = await assertAllowedPath(
			'/home/user/uploads/cat.jpg',
			[ '/home/user/uploads' ]
		);
		expect( resolved ).toBe( '/home/user/uploads/cat.jpg' );
	} );

	it( 'rejects when a symlink resolves outside the allowlist', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/etc/passwd' );
		await expect(
			assertAllowedPath( '/home/user/uploads/link.jpg', [ '/home/user/uploads' ] )
		).rejects.toThrow( /not allowed/i );
	} );

	it( 'rejects a `..` traversal whose realpath escapes the allowlist', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/home/user/secret.key' );
		await expect(
			assertAllowedPath( '/home/user/uploads/../secret.key', [ '/home/user/uploads' ] )
		).rejects.toThrow( /not allowed/i );
	} );

	it( 'does not match a sibling directory with a similar prefix', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/home/user/uploads-secret/stuff.key' );
		await expect(
			assertAllowedPath(
				'/home/user/uploads-secret/stuff.key',
				[ '/home/user/uploads' ]
			)
		).rejects.toThrow( /not allowed/i );
	} );

	it( 'accepts when the resolved path equals the allowlist entry exactly', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/home/user/uploads' );
		const resolved = await assertAllowedPath(
			'/home/user/uploads',
			[ '/home/user/uploads' ]
		);
		expect( resolved ).toBe( '/home/user/uploads' );
	} );

	it( 'accepts when the file is under any of several allowlist entries', async () => {
		vi.mocked( realpath ).mockResolvedValueOnce( '/var/lib/photos/b.jpg' );
		const resolved = await assertAllowedPath(
			'/var/lib/photos/b.jpg',
			[ '/home/user/uploads', '/var/lib/photos' ]
		);
		expect( resolved ).toBe( '/var/lib/photos/b.jpg' );
	} );
} );
