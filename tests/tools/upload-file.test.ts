import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { fakeContext } from '../helpers/fakeContext.ts';

vi.mock('../../src/transport/uploadGuard.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/uploadGuard.ts')>(
		'../../src/transport/uploadGuard.ts',
	);
	return {
		...actual,
		assertAllowedPath: vi.fn(),
	};
});

import { assertAllowedPath, UploadValidationError } from '../../src/transport/uploadGuard.ts';
import { uploadFile } from '../../src/tools/upload-file.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

describe('upload-file', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('categorises UploadValidationError as invalid_input and does not call mwn.upload', async () => {
		vi.mocked(assertAllowedPath).mockRejectedValue(
			new UploadValidationError(
				'"/etc/passwd" is not allowed by the configured upload directories.',
			),
		);
		const mock = createMockMwn({ upload: vi.fn() });
		const submitUpload = vi.fn();
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submitUpload },
			uploadDirs: { list: () => ['/home/user/uploads'] },
		});

		const result = await uploadFile.handle(
			{
				filepath: '/etc/passwd',
				title: 'File:Shadow',
				text: 'body',
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/Failed to upload file:.*not allowed/);
		expect(submitUpload).not.toHaveBeenCalled();
		expect(mock.upload).not.toHaveBeenCalled();
	});

	it('lets unexpected guard errors fall through to the dispatcher', async () => {
		vi.mocked(assertAllowedPath).mockRejectedValue(new Error('Connection refused'));
		const mock = createMockMwn({ upload: vi.fn() });
		const submitUpload = vi.fn();
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submitUpload },
			uploadDirs: { list: () => ['/home/user/uploads'] },
		});

		const result = await dispatch(
			uploadFile,
			ctx,
		)({
			filepath: '/home/user/uploads/x.jpg',
			title: 'File:X',
			text: 'body',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/Failed to upload file: Connection refused/);
		expect(submitUpload).not.toHaveBeenCalled();
	});

	it('returns a structured payload on success and routes through ctx.edit.submitUpload', async () => {
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
		const mock = createMockMwn({ upload: vi.fn() });
		const submitUpload = vi.fn().mockResolvedValue({
			result: 'Success',
			filename: 'Cat.jpg',
			imageinfo: {
				descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
				url: 'https://test.wiki/images/Cat.jpg',
			},
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submitUpload },
			uploadDirs: { list: () => ['/home/user/uploads'] },
		});

		const result = await uploadFile.handle(
			{
				filepath: '/home/user/uploads/cat.jpg',
				title: 'File:Cat.jpg',
				text: 'A cat.',
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(text).toContain('Page URL: https://test.wiki/wiki/File:Cat.jpg');
		expect(text).toContain('File URL: https://test.wiki/images/Cat.jpg');

		expect(submitUpload).toHaveBeenCalledWith(
			mock,
			'/var/lib/uploads/cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			expect.objectContaining({
				comment: expect.stringContaining('upload-file'),
			}),
		);
	});

	it('passes ctx.uploadDirs.list() to the path guard', async () => {
		vi.mocked(assertAllowedPath).mockResolvedValue('/home/user/uploads/x.jpg');
		const mock = createMockMwn();
		const submitUpload = vi.fn().mockResolvedValue({ result: 'Success' });
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submitUpload },
			uploadDirs: { list: () => ['/home/user/uploads'] },
		});

		await uploadFile.handle(
			{
				filepath: '/home/user/uploads/x.jpg',
				title: 'File:X',
				text: 'body',
			},
			ctx,
		);

		expect(assertAllowedPath).toHaveBeenCalledWith('/home/user/uploads/x.jpg', [
			'/home/user/uploads',
		]);
	});

	it('dispatches permissiondenied as permission_denied via dispatcher', async () => {
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
		const mock = createMockMwn();
		const submitUpload = vi.fn().mockRejectedValue(createMockMwnError('permissiondenied'));
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: { ...baseEdit, submitUpload },
			uploadDirs: { list: () => ['/home/user/uploads'] },
		});

		const result = await dispatch(
			uploadFile,
			ctx,
		)({
			filepath: '/home/user/uploads/cat.jpg',
			title: 'File:Cat.jpg',
			text: 'A cat.',
		});

		assertStructuredError(result, 'permission_denied', 'permissiondenied');
	});
});
