import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
	realpath: vi.fn(),
}));

import { realpath } from 'node:fs/promises';
import { UploadDirsImpl } from '../../src/wikis/uploadDirs.ts';

function resolveIn(dirs: string[], filepath: string): Promise<string> {
	return new UploadDirsImpl(dirs).resolve(filepath);
}

describe('UploadDirsImpl', () => {
	it('returns the configured list', () => {
		const u = new UploadDirsImpl(['/srv/uploads', '/data']);
		expect(u.list()).toEqual(['/srv/uploads', '/data']);
	});

	it('returns an empty list when constructed with []', () => {
		expect(new UploadDirsImpl([]).list()).toEqual([]);
	});
});

describe('UploadDirsImpl.resolve', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects when no directories are configured', async () => {
		await expect(resolveIn([], '/home/user/file.jpg')).rejects.toThrow(
			/MCP_UPLOAD_DIRS|uploadDirs/,
		);
	});

	it('rejects a relative filepath', async () => {
		await expect(resolveIn(['/home/user/uploads'], 'relative/file.jpg')).rejects.toThrow(
			/absolute path/,
		);
	});

	it('rejects a non-existent filepath with a clear message', async () => {
		vi.mocked(realpath).mockRejectedValueOnce(
			Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
		);
		await expect(resolveIn(['/home/user/uploads'], '/home/user/missing.jpg')).rejects.toThrow(
			/file not found/i,
		);
	});

	it('accepts and returns the canonical path for a file inside an allowed dir', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/home/user/uploads/cat.jpg');
		const resolved = await resolveIn(['/home/user/uploads'], '/home/user/uploads/cat.jpg');
		expect(resolved).toBe('/home/user/uploads/cat.jpg');
	});

	it('rejects when a symlink resolves outside the allowlist', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/etc/passwd');
		await expect(resolveIn(['/home/user/uploads'], '/home/user/uploads/link.jpg')).rejects.toThrow(
			/outside the allowed upload directories/,
		);
	});

	it('rejects a `..` traversal whose realpath escapes the allowlist', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/home/user/secret.key');
		await expect(
			resolveIn(['/home/user/uploads'], '/home/user/uploads/../secret.key'),
		).rejects.toThrow(/outside the allowed upload directories/);
	});

	it('does not match a sibling directory with a similar prefix', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/home/user/uploads-secret/stuff.key');
		await expect(
			resolveIn(['/home/user/uploads'], '/home/user/uploads-secret/stuff.key'),
		).rejects.toThrow(/outside the allowed upload directories/);
	});

	it('accepts when the resolved path equals the allowlist entry exactly', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/home/user/uploads');
		const resolved = await resolveIn(['/home/user/uploads'], '/home/user/uploads');
		expect(resolved).toBe('/home/user/uploads');
	});

	it('accepts when the file is under any of several allowlist entries', async () => {
		vi.mocked(realpath).mockResolvedValueOnce('/var/lib/photos/b.jpg');
		const resolved = await resolveIn(
			['/home/user/uploads', '/var/lib/photos'],
			'/var/lib/photos/b.jpg',
		);
		expect(resolved).toBe('/var/lib/photos/b.jpg');
	});
});
