import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from 'node-fetch';
import { createMockMwn, type MockMwn } from '../helpers/mock-mwn.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { fakeContext } from '../helpers/fakeContext.ts';

vi.mock('../../src/transport/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/httpFetch.ts')>(
		'../../src/transport/httpFetch.ts',
	);
	return { ...actual, fetchFileBytes: vi.fn() };
});

import {
	fetchFileBytes,
	FileTooLargeError,
	HttpStatusError,
} from '../../src/transport/httpFetch.ts';
import { uploadFileFromUrl } from '../../src/tools/upload-file-from-url.ts';
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

// The wiki's answer to an imageinfo query for a file it already holds.
const EXISTING_FILE = {
	query: {
		pages: [{ title: 'File:Cat.jpg', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] }],
	},
};

// A wiki that does not hold the file yet, so an upload to it goes ahead.
function wikiWithoutFile(overrides: Partial<MockMwn> = {}): MockMwn {
	return createMockMwn({
		request: vi.fn().mockResolvedValue({
			query: { pages: [{ title: 'File:Cat.jpg', missing: true }] },
		}),
		...overrides,
	});
}

function ctxWithServerUpload(
	mock: ReturnType<typeof createMockMwn>,
	submitUploadFromBytes = vi.fn().mockResolvedValue(UPLOAD_OK),
) {
	return fakeContext({
		mwn: async () => mock as never,
		edit: { ...baseEdit, submitUploadFromBytes },
	});
}

describe('upload-file-from-url', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchFileBytes).mockResolvedValue(Buffer.from('IMG'));
	});

	it('server-first: fetches the bytes and uploads via multipart, not wiki copy-upload', async () => {
		const mock = wikiWithoutFile({ uploadFromUrl: vi.fn() });
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
		const mock = wikiWithoutFile({ uploadFromUrl: vi.fn().mockResolvedValue(UPLOAD_OK) });
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
		const mock = wikiWithoutFile({ uploadFromUrl: vi.fn().mockResolvedValue(UPLOAD_OK) });
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
		const mock = wikiWithoutFile({ uploadFromUrl: vi.fn() });
		const ctx = ctxWithServerUpload(mock, vi.fn());

		const result = await dispatch(
			uploadFileFromUrl,
			ctx,
		)({ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: '' });

		assertStructuredError(result, 'upstream_failure');
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('surfaces a permissiondenied from the server-side upload as permission_denied (no rescue)', async () => {
		const mock = wikiWithoutFile({ uploadFromUrl: vi.fn() });
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
		const mock = wikiWithoutFile({
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

	it('fails as conflict when the file already exists, without fetching or uploading it', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(EXISTING_FILE),
			uploadFromUrl: vi.fn(),
		});
		const submit = vi.fn().mockResolvedValue(UPLOAD_OK);
		const ctx = ctxWithServerUpload(mock, submit);

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' },
			ctx,
		);

		const envelope = assertStructuredError(result, 'conflict');
		expect(envelope.message).toContain('update-file-from-url');
		expect(fetchFileBytes).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(mock.uploadFromUrl).not.toHaveBeenCalled();
	});

	it('forwards configured tags on the wiki-rescue path via applyTags', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const mock = wikiWithoutFile({
			uploadFromUrl: vi.fn().mockResolvedValue({ result: 'Success', filename: 'Cat.jpg' }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				...baseEdit,
				submitUploadFromBytes: vi.fn(),
				applyTags: <T extends Record<string, unknown>>(o: T) => ({ ...o, tags: 'mcp-server' }),
			},
		});

		await uploadFileFromUrl.handle(
			{ url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' },
			ctx,
		);

		expect(mock.uploadFromUrl.mock.calls[0][3]).toHaveProperty('tags', 'mcp-server');
	});
});
