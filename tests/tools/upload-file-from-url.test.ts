import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { contextWritingTo, writingWiki } from '../helpers/writingWiki.ts';
import { FILE_EXISTS, FILE_MISSING, UPLOADED } from '../helpers/uploadingWiki.ts';
import { RequestFailedError } from '../../src/outbound/httpFetch.ts';

const CAT = { url: 'https://source.example/cat.jpg', title: 'File:Cat.jpg', text: 'A cat.' };

// A wiki without the file yet, answering an upload with `response`.
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

		const result = await uploadFileFromUrl.handle(CAT, contextWritingTo(wiki));

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Filename: Cat.jpg');
		expect(text).toContain('Page URL: https://test.wiki/wiki/File:Cat.jpg');
		expect(text).toContain('File URL: https://test.wiki/images/Cat.jpg');
		expect(fetchFileBytes).toHaveBeenCalledWith('https://source.example/cat.jpg');
		const sent = wiki.sentWrite();
		expect(sent.get('file')).toBe('IMG');
		expect(sent.get('filename')).toBe('File:Cat.jpg');
		expect(sent.get('text')).toBe('A cat.');
		expect(sent.get('comment')).toContain('upload-file-from-url');
		expect(sent.has('url')).toBe(false);
	});

	it('asks the wiki to fetch the file when the server cannot reach the URL', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new RequestFailedError('https://source.example/file', new Error('connect ECONNREFUSED')),
		);
		const wiki = wikiWithoutFile();

		const result = await uploadFileFromUrl.handle(CAT, contextWritingTo(wiki));

		assertStructuredSuccess(result);
		expect(wiki.writes).toHaveLength(1);
		const sent = wiki.sentWrite();
		expect(sent.get('action')).toBe('upload');
		expect(sent.get('url')).toBe('https://source.example/cat.jpg');
		expect(sent.get('filename')).toBe('File:Cat.jpg');
		expect(sent.get('text')).toBe('A cat.');
		expect(sent.get('comment')).toContain('upload-file-from-url');
	});

	it('asks the wiki to fetch the file when it exceeds the size cap', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FileTooLargeError(200_000_000, 104_857_600));
		const wiki = wikiWithoutFile();

		const result = await uploadFileFromUrl.handle(
			{ url: 'https://source.example/big.tif', title: 'File:Big.tif', text: '' },
			contextWritingTo(wiki),
		);

		assertStructuredSuccess(result);
		expect(wiki.sentWrite().get('url')).toBe('https://source.example/big.tif');
	});

	it('does not hand the file to the wiki when the source returns an HTTP error', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new HttpStatusError(404, 'https://source.example/cat.jpg'),
		);
		const wiki = wikiWithoutFile();

		const result = await dispatch(uploadFileFromUrl, contextWritingTo(wiki))(CAT);

		assertStructuredError(result, 'upstream_failure');
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('reports a refused upload of the fetched bytes as permission_denied, without a copy-upload', async () => {
		const wiki = wikiWithoutFile({
			error: { code: 'permissiondenied', info: 'You do not have permission' },
		});

		const result = await dispatch(uploadFileFromUrl, contextWritingTo(wiki))(CAT);

		assertStructuredError(result, 'permission_denied');
		expect(wiki.writes).toHaveLength(1);
		expect(wiki.sentWrite().get('file')).toBe('IMG');
	});

	it('says both routes failed when the server cannot reach the URL and the wiki has copy-upload disabled', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new RequestFailedError('https://source.example/file', new Error('timeout')),
		);
		const wiki = wikiWithoutFile({
			error: { code: 'copyuploaddisabled', info: 'Uploads by URL are not enabled.' },
		});

		const result = await uploadFileFromUrl.handle(CAT, contextWritingTo(wiki));

		const envelope = assertStructuredError(result, 'upstream_failure', 'copyuploaddisabled');
		expect(envelope.message).toMatch(/could not reach it and the wiki has upload-by-URL disabled/);
	});

	it('fails as conflict when the file already exists, without fetching or uploading it', async () => {
		const wiki = writingWiki({ upload: UPLOADED }, { read: FILE_EXISTS });

		const result = await uploadFileFromUrl.handle(CAT, contextWritingTo(wiki));

		const envelope = assertStructuredError(result, 'conflict');
		expect(envelope.message).toContain('update-file-from-url');
		expect(fetchFileBytes).not.toHaveBeenCalled();
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it("tags a copy-upload with the wiki's configured tags", async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(
			new RequestFailedError('https://source.example/file', new Error('refused')),
		);
		const wiki = wikiWithoutFile();

		await uploadFileFromUrl.handle(CAT, contextWritingTo(wiki, 'mcp-server'));

		expect(wiki.sentWrite().get('tags')).toBe('mcp-server');
	});
});
