import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';

vi.mock('../../src/transport/uploadGuard.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/uploadGuard.js')>(
		'../../src/transport/uploadGuard.js',
	);
	return {
		...actual,
		assertAllowedPath: vi.fn(),
	};
});

vi.mock('../../src/transport/fileExistence.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/fileExistence.js')>(
		'../../src/transport/fileExistence.js',
	);
	return {
		...actual,
		assertFileExists: vi.fn(),
	};
});

import { assertAllowedPath, UploadValidationError } from '../../src/transport/uploadGuard.js';
import { assertFileExists, FileNotFoundError } from '../../src/transport/fileExistence.js';
import { updateFile } from '../../src/tools/update-file.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

function ctxWith(
	opts: {
		mwn?: ReturnType<typeof createMockMwn>;
		submitUpload?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const mwn = opts.mwn ?? createMockMwn();
	const submitUpload = opts.submitUpload ?? vi.fn();
	const ctx = fakeContext({
		mwn: async () => mwn as never,
		edit: {
			submit: vi.fn() as never,
			submitUpload: submitUpload as never,
			applyTags: (o: object) => ({ ...o }),
		},
		uploadDirs: { list: () => ['/home/user/uploads'] },
	});
	return { mwn, submitUpload, ctx };
}

describe('update-file', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns invalid_input for UploadValidationError, skips pre-flight and upload', async () => {
		vi.mocked(assertAllowedPath).mockRejectedValue(
			new UploadValidationError('"/etc/passwd" is not allowed'),
		);
		const { submitUpload, ctx } = ctxWith();

		const result = await updateFile.handle(
			{
				filepath: '/etc/passwd',
				title: 'File:Shadow',
			},
			ctx,
		);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/Failed to update file:.*not allowed/);
		expect(assertFileExists).not.toHaveBeenCalled();
		expect(submitUpload).not.toHaveBeenCalled();
	});

	it('lets unexpected guard errors fall through to the dispatcher', async () => {
		vi.mocked(assertAllowedPath).mockRejectedValue(new Error('Connection refused'));
		const { submitUpload, ctx } = ctxWith();

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
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
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
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
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
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
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
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
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
		vi.mocked(assertAllowedPath).mockResolvedValue('/var/lib/uploads/cat.jpg');
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

	it('forwards ctx.uploadDirs.list() to the path guard', async () => {
		vi.mocked(assertAllowedPath).mockResolvedValue('/home/user/uploads/x.jpg');
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		const submitUpload = vi.fn().mockResolvedValue({ result: 'Success' });
		const { ctx } = ctxWith({ submitUpload });

		await updateFile.handle(
			{
				filepath: '/home/user/uploads/x.jpg',
				title: 'File:X',
			},
			ctx,
		);

		expect(assertAllowedPath).toHaveBeenCalledWith('/home/user/uploads/x.jpg', [
			'/home/user/uploads',
		]);
	});
});
