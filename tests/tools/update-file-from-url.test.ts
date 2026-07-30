import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from 'node-fetch';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import type { EditService } from '../../src/services/editService.ts';

vi.mock('../../src/transport/fileExistence.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/fileExistence.ts')>(
		'../../src/transport/fileExistence.ts',
	);
	return { ...actual, assertFileExists: vi.fn() };
});

vi.mock('../../src/transport/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/httpFetch.ts')>(
		'../../src/transport/httpFetch.ts',
	);
	return { ...actual, fetchFileBytes: vi.fn() };
});

import { assertFileExists, FileNotFoundError } from '../../src/transport/fileExistence.ts';
import { fetchFileBytes } from '../../src/transport/httpFetch.ts';
import { updateFileFromUrl } from '../../src/tools/update-file-from-url.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

const UPLOAD_OK = {
	result: 'Success',
	filename: 'Cat.jpg',
	imageinfo: {
		descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
		url: 'https://test.wiki/images/Cat.jpg',
	},
};

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

function ctxWithServerUpload(
	mock: ReturnType<typeof createMockMwn>,
	submitUploadFromBytes = vi.fn().mockResolvedValue(UPLOAD_OK),
	applyTags: EditService['applyTags'] = (o) => ({ ...o }),
) {
	return fakeContext({
		mwn: async () => mock as never,
		edit: { ...baseEdit, submitUploadFromBytes, applyTags },
	});
}

describe('update-file-from-url', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertFileExists).mockResolvedValue(undefined);
		vi.mocked(fetchFileBytes).mockResolvedValue(Buffer.from('IMG'));
	});

	it('returns not_found with routing hint when the file does not exist', async () => {
		vi.mocked(assertFileExists).mockRejectedValue(new FileNotFoundError('Cat.jpg'));
		const mock = createMockMwn({ uploadFromUrl: vi.fn() });
		const submit = vi.fn();
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await updateFileFromUrl.handle(
			{ url: 'https://example.com/cat.jpg', title: 'Cat.jpg' },
			ctx,
		);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toMatch(/Cat\.jpg/);
		expect(envelope.message).toMatch(/upload-file-from-url\b/);
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it('server-first: fetches the bytes and uploads via multipart with text=""', async () => {
		const mock = createMockMwn({ uploadFromUrl: vi.fn() });
		const submit = vi.fn().mockResolvedValue(UPLOAD_OK);
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await updateFileFromUrl.handle(
			{ url: 'https://example.com/cat.jpg', title: 'File:Cat.jpg', comment: 'Higher res' },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(submit).toHaveBeenCalledWith(
			mock,
			expect.any(Buffer),
			'Cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining({
				ignorewarnings: true,
				comment: expect.stringMatching(/^Higher res.*update-file-from-url/),
			}),
		);
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('rescues to wiki copy-upload (ignorewarnings:true, text="") when the server cannot reach', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const mock = createMockMwn({ uploadFromUrl: vi.fn().mockResolvedValue(UPLOAD_OK) });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		await updateFileFromUrl.handle(
			{ url: 'https://example.com/cat.jpg', title: 'File:Cat.jpg', comment: 'Higher res' },
			ctx,
		);

		expect(mock.uploadFromUrl).toHaveBeenCalledWith(
			'https://example.com/cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining({
				ignorewarnings: true,
				comment: expect.stringMatching(/^Higher res.*update-file-from-url/),
			}),
		);
	});

	it('dispatches generic upload errors with the standard verb prefix', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const mock = createMockMwn({ uploadFromUrl: vi.fn().mockRejectedValue(new Error('Boom')) });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await dispatch(
			updateFileFromUrl,
			ctx,
		)({ url: 'https://example.com/cat.jpg', title: 'File:Cat.jpg' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/Failed to update file: Boom/);
	});

	it('maps permissiondenied-coded errors to permission_denied', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const err = createMockMwnError('permissiondenied', 'You cannot reupload');
		const mock = createMockMwn({ uploadFromUrl: vi.fn().mockRejectedValue(err) });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await dispatch(
			updateFileFromUrl,
			ctx,
		)({ url: 'https://example.com/cat.jpg', title: 'File:Cat.jpg' });

		assertStructuredError(result, 'permission_denied');
	});

	it('forwards configured tags on the wiki-rescue path via applyTags', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const mock = createMockMwn({
			uploadFromUrl: vi.fn().mockResolvedValue({ result: 'Success', filename: 'Cat.jpg' }),
		});
		const ctx = ctxWithServerUpload(mock, vi.fn(), (o) => ({ ...o, tags: 'mcp-server' }));

		await updateFileFromUrl.handle(
			{ url: 'https://example.com/cat.jpg', title: 'File:Cat.jpg' },
			ctx,
		);

		expect(mock.uploadFromUrl.mock.calls[0][3]).toHaveProperty('tags', 'mcp-server');
	});
});
