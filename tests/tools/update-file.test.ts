import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext, contextOn, uploadDirsResolving } from '../helpers/fakeContext.ts';

vi.mock('../../src/wikis/fileExistence.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/wikis/fileExistence.ts')>(
		'../../src/wikis/fileExistence.ts',
	);
	return {
		...actual,
		assertFileExists: vi.fn(),
	};
});

import { UploadDirsImpl, type UploadDirs } from '../../src/wikis/uploadDirs.ts';
import { assertFileExists, FileNotFoundError } from '../../src/wikis/fileExistence.ts';
import { updateFile } from '../../src/tools/update-file.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function ctxWith(
	opts: {
		mwn?: ReturnType<typeof createMockMwn>;
		submitUpload?: Mock;
		uploadDirs?: UploadDirs;
	} = {},
) {
	const mwn = opts.mwn ?? createMockMwn();
	const submitUpload = opts.submitUpload ?? vi.fn();
	const ctx = contextOn(mwn, {
		edit: { ...baseEdit, submitUpload },
		uploadDirs: opts.uploadDirs ?? uploadDirsResolving('/var/lib/uploads/cat.jpg'),
	});
	return { mwn, submitUpload, ctx };
}

describe('update-file', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses a path the upload directories reject as invalid_input, skipping pre-flight and upload', async () => {
		const { submitUpload, ctx } = ctxWith({ uploadDirs: new UploadDirsImpl([]) });

		const result = await updateFile.handle(
			{
				filepath: '/etc/passwd',
				title: 'File:Shadow',
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/Failed to update file: uploads are disabled/);
		expect(assertFileExists).not.toHaveBeenCalled();
		expect(submitUpload).not.toHaveBeenCalled();
	});

	it('lets unexpected path-resolution errors fall through to the dispatcher', async () => {
		const { submitUpload, ctx } = ctxWith({
			uploadDirs: {
				list: () => ['/home/user/uploads'],
				resolve: () => Promise.reject(new Error('EACCES: permission denied')),
			},
		});

		const result = await dispatch(
			updateFile,
			ctx,
		)({
			filepath: '/home/user/uploads/x.jpg',
			title: 'File:X',
		});

		assertStructuredError(result, 'upstream_failure');
		expect(submitUpload).not.toHaveBeenCalled();
	});

	it('returns not_found with routing hint when the file does not exist', async () => {
		vi.mocked(assertFileExists).mockRejectedValue(new FileNotFoundError('Cat.jpg'));
		const { submitUpload, ctx } = ctxWith();

		const result = await updateFile.handle(
			{
				filepath: '/home/user/uploads/cat.jpg',
				title: 'Cat.jpg',
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toMatch(/Cat\.jpg/);
		expect(envelope.message).toMatch(/upload-file\b/);
		expect(submitUpload).not.toHaveBeenCalled();
	});

	it('calls submitUpload with ignorewarnings: true and the formatted comment', async () => {
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		const submitUpload = vi.fn().mockResolvedValue({
			result: 'Success',
			filename: 'Cat.jpg',
			imageinfo: {
				descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
				url: 'https://test.wiki/images/Cat.jpg',
			},
		});
		const { mwn, ctx } = ctxWith({ submitUpload });

		await updateFile.handle(
			{
				filepath: '/home/user/uploads/cat.jpg',
				title: 'File:Cat.jpg',
				comment: 'New colour pass',
			},
			ctx,
		);

		expect(submitUpload).toHaveBeenCalledWith(
			mwn,
			'/var/lib/uploads/cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining({
				ignorewarnings: true,
				comment: expect.stringMatching(/^New colour pass.*update-file/),
			}),
		);
	});

	it('returns the same structured payload as upload-file on success', async () => {
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		const submitUpload = vi.fn().mockResolvedValue({
			result: 'Success',
			filename: 'Cat.jpg',
			imageinfo: {
				descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
				url: 'https://test.wiki/images/Cat.jpg',
			},
		});
		const { ctx } = ctxWith({ submitUpload });

		const result = await updateFile.handle(
			{
				filepath: '/home/user/uploads/cat.jpg',
				title: 'File:Cat.jpg',
			},
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(text).toContain('Page URL: https://test.wiki/wiki/File:Cat.jpg');
		expect(text).toContain('File URL: https://test.wiki/images/Cat.jpg');
	});

	it('dispatches generic upstream errors with the standard verb prefix', async () => {
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		const submitUpload = vi.fn().mockRejectedValue(new Error('Boom'));
		const { ctx } = ctxWith({ submitUpload });

		const result = await dispatch(
			updateFile,
			ctx,
		)({
			filepath: '/home/user/uploads/cat.jpg',
			title: 'File:Cat.jpg',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/Failed to update file: Boom/);
	});

	it('maps permissiondenied-coded errors to permission_denied', async () => {
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		const err = Object.assign(new Error('You cannot reupload'), { code: 'permissiondenied' });
		const submitUpload = vi.fn().mockRejectedValue(err);
		const { ctx } = ctxWith({ submitUpload });

		const result = await dispatch(
			updateFile,
			ctx,
		)({
			filepath: '/home/user/uploads/cat.jpg',
			title: 'File:Cat.jpg',
		});

		assertStructuredError(result, 'permission_denied');
	});
});
