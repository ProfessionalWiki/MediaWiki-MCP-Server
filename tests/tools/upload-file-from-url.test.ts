import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from 'node-fetch';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';

vi.mock('../../src/transport/httpFetch.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/httpFetch.js')>(
		'../../src/transport/httpFetch.js',
	);
	return { ...actual, fetchFileBytes: vi.fn() };
});

import {
	fetchFileBytes,
	FileTooLargeError,
	HttpStatusError,
} from '../../src/transport/httpFetch.js';
import { uploadFileFromUrl } from '../../src/tools/upload-file-from-url.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

const UPLOAD_OK = {
	result: 'Success',
	filename: 'Cat.jpg',
	imageinfo: {
		descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
		url: 'https://test.wiki/images/Cat.jpg',
	},
};

function ctxWithServerUpload(
	mock: ReturnType<typeof createMockMwn>,
	submitUploadFromBytes = vi.fn().mockResolvedValue(UPLOAD_OK),
) {
	return fakeContext({
		mwn: async () => mock as never,
		edit: {
			submit: vi.fn() as never,
			submitUpload: vi.fn() as never,
			submitUploadFromBytes: submitUploadFromBytes as never,
			applyTags: (o: object) => ({ ...o }),
		},
	});
}

describe('upload-file-from-url', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchFileBytes).mockResolvedValue(Buffer.from('IMG'));
	});

	it('server-first: fetches the bytes and uploads via multipart, not wiki copy-upload', async () => {
		const mock = createMockMwn({ uploadFromUrl: vi.fn() });
		const submit = vi.fn().mockResolvedValue(UPLOAD_OK);
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(text).toContain('Page URL: https://test.wiki/wiki/File:Cat.jpg');
		expect(text).toContain('File URL: https://test.wiki/images/Cat.jpg');
		expect(fetchFileBytes).toHaveBeenCalledWith('https://source.example/cat.jpg');
		expect(submit).toHaveBeenCalledWith(
			mock,
			expect.any(Buffer),
			'Cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			expect.objectContaining({ comment: expect.stringContaining('upload-file-from-url') }),
		);
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('rescues to wiki copy-upload when the server cannot reach the URL', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('connect ECONNREFUSED', 'system'));
		const mock = createMockMwn({ uploadFromUrl: vi.fn().mockResolvedValue(UPLOAD_OK) });
		const submit = vi.fn();
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' },
			ctx,
		);

		assertStructuredSuccess(result);
		expect(mock.uploadFromUrl).toHaveBeenCalledWith(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			expect.objectContaining({ comment: expect.stringContaining('upload-file-from-url') }),
		);
		expect(submit).not.toHaveBeenCalled();
	});

	it('rescues to wiki copy-upload when the file exceeds the size cap', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FileTooLargeError(200_000_000, 104_857_600));
		const mock = createMockMwn({ uploadFromUrl: vi.fn().mockResolvedValue(UPLOAD_OK) });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/big.tif', title: 'File:Big.tif', text: '' },
			ctx,
		);

		assertStructuredSuccess(result);
		expect(mock.uploadFromUrl).toHaveBeenCalled();
	});

	it('does NOT rescue when the source returns an HTTP error; surfaces upstream_failure', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new HttpStatusError(404, 'https://source.example/cat.jpg'),
		);
		const mock = createMockMwn({ uploadFromUrl: vi.fn() });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await dispatch(
			uploadFileFromUrl,
			ctx,
		)({ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: '' });

		assertStructuredError(result, 'upstream_failure');
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('surfaces a permissiondenied from the server-side upload as permission_denied (no rescue)', async () => {
		const mock = createMockMwn({ uploadFromUrl: vi.fn() });
		const submit = vi
			.fn()
			.mockRejectedValue(createMockMwnError('permissiondenied', 'You do not have permission'));
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await dispatch(
			uploadFileFromUrl,
			ctx,
		)({ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: '' });

		assertStructuredError(result, 'permission_denied');
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('when server cannot reach AND wiki copy-uploads disabled, returns a combined upstream_failure', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('timeout', 'system'));
		const mock = createMockMwn({
			uploadFromUrl: vi
				.fn()
				.mockRejectedValue(
					createMockMwnError('copyuploaddisabled', 'copyuploaddisabled: disabled'),
				),
		});
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: '' },
			ctx,
		);

		const envelope = assertStructuredError(result, 'upstream_failure', 'copyuploaddisabled');
		expect(envelope.message).toMatch(/could not reach it and the wiki has upload-by-URL disabled/);
	});

	it('forwards configured tags on the wiki-rescue path via applyTags', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const mock = createMockMwn({
			uploadFromUrl: vi.fn().mockResolvedValue({ result: 'Success', filename: 'Cat.jpg' }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				submitUploadFromBytes: vi.fn() as never,
				applyTags: (o: object) => ({ ...o, tags: 'mcp-server' }),
			},
		});

		await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' },
			ctx,
		);

		expect(mock.uploadFromUrl.mock.calls[0][3]).toHaveProperty('tags', 'mcp-server');
	});
});
