import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from 'node-fetch';

vi.mock('../../src/outbound/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/outbound/httpFetch.ts')>(
		'../../src/outbound/httpFetch.ts',
	);
	return { ...actual, fetchFileBytes: vi.fn() };
});

import {
	fetchFileBytes,
	FileTooLargeError,
	HttpStatusError,
} from '../../src/outbound/httpFetch.ts';
import { uploadFileFromUrl } from '../../src/tools/upload-file-from-url.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { writingWiki } from '../helpers/writingWiki.ts';
import {
	contextUploadingTo,
	FILE_EXISTS,
	FILE_MISSING,
	UPLOADED,
} from '../helpers/uploadingWiki.ts';

const CAT = { url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' };

// A wiki without the file yet, answering a copy-upload with `response`.
function wikiWithoutFile(response: object = { upload: UPLOADED }): ReturnType<typeof writingWiki> {
	return writingWiki(response, { read: FILE_MISSING });
}

describe('upload-file-from-url', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchFileBytes).mockResolvedValue(Buffer.from('IMG'));
	});

	it('server-first: fetches the bytes and uploads them itself, not by wiki copy-upload', async () => {
		const wiki = wikiWithoutFile();
		const uploadBytes = vi.fn().mockResolvedValue(UPLOADED);

		const result = await uploadFileFromUrl.handle(CAT, contextUploadingTo(wiki, uploadBytes));

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(text).toContain('Page URL: https://test.wiki/wiki/File:Cat.jpg');
		expect(text).toContain('File URL: https://test.wiki/images/Cat.jpg');
		expect(fetchFileBytes).toHaveBeenCalledWith('https://source.example/cat.jpg');
		expect(uploadBytes).toHaveBeenCalledWith(
			wiki.mwn,
			expect.any(Buffer),
			'Cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			expect.objectContaining({ comment: expect.stringContaining('upload-file-from-url') }),
		);
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('asks the wiki to fetch the file when the server cannot reach the URL', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('connect ECONNREFUSED', 'system'));
		const wiki = wikiWithoutFile();
		const uploadBytes = vi.fn();

		const result = await uploadFileFromUrl.handle(CAT, contextUploadingTo(wiki, uploadBytes));

		assertStructuredSuccess(result);
		const sent = wiki.sentWrite();
		expect(sent.get('action')).toBe('upload');
		expect(sent.get('url')).toBe('https://source.example/cat.jpg');
		expect(sent.get('filename')).toBe('File:Cat.jpg');
		expect(sent.get('text')).toBe('A cat.');
		expect(sent.get('comment')).toContain('upload-file-from-url');
		expect(uploadBytes).not.toHaveBeenCalled();
	});

	it('asks the wiki to fetch the file when it exceeds the size cap', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FileTooLargeError(200_000_000, 104_857_600));
		const wiki = wikiWithoutFile();

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/big.tif', title: 'File:Big.tif', text: '' },
			contextUploadingTo(wiki, vi.fn()),
		);

		assertStructuredSuccess(result);
		expect(wiki.sentWrite().get('url')).toBe('https://source.example/big.tif');
	});

	it('does not hand the file to the wiki when the source returns an HTTP error', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new HttpStatusError(404, 'https://source.example/cat.jpg'),
		);
		const wiki = wikiWithoutFile();

		const result = await dispatch(uploadFileFromUrl, contextUploadingTo(wiki, vi.fn()))(CAT);

		assertStructuredError(result, 'upstream_failure');
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('reports a refused upload of the fetched bytes as permission_denied, without a copy-upload', async () => {
		const wiki = wikiWithoutFile();
		const uploadBytes = vi
			.fn()
			.mockRejectedValue(createMockMwnError('permissiondenied', 'You do not have permission'));

		const result = await dispatch(uploadFileFromUrl, contextUploadingTo(wiki, uploadBytes))(CAT);

		assertStructuredError(result, 'permission_denied');
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('says both routes failed when the server cannot reach the URL and the wiki has copy-upload disabled', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('timeout', 'system'));
		const wiki = wikiWithoutFile({
			error: { code: 'copyuploaddisabled', info: 'Uploads by URL are not enabled.' },
		});

		const result = await uploadFileFromUrl.handle(CAT, contextUploadingTo(wiki, vi.fn()));

		const envelope = assertStructuredError(result, 'upstream_failure', 'copyuploaddisabled');
		expect(envelope.message).toMatch(/could not reach it and the wiki has upload-by-URL disabled/);
	});

	it('fails as conflict when the file already exists, without fetching or uploading it', async () => {
		const wiki = writingWiki({ upload: UPLOADED }, { read: FILE_EXISTS });
		const uploadBytes = vi.fn();

		const result = await uploadFileFromUrl.handle(CAT, contextUploadingTo(wiki, uploadBytes));

		const envelope = assertStructuredError(result, 'conflict');
		expect(envelope.message).toContain('update-file-from-url');
		expect(fetchFileBytes).not.toHaveBeenCalled();
		expect(uploadBytes).not.toHaveBeenCalled();
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it("tags a copy-upload with the wiki's configured tags", async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const wiki = wikiWithoutFile();

		await uploadFileFromUrl.handle(CAT, contextUploadingTo(wiki, vi.fn(), 'mcp-server'));

		expect(wiki.sentWrite().get('tags')).toBe('mcp-server');
	});
});
