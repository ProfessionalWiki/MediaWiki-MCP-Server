import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from 'node-fetch';

vi.mock('../../src/transport/httpFetch.ts', async () => {
	const actual = await vi.importActual<typeof import('../../src/transport/httpFetch.ts')>(
		'../../src/transport/httpFetch.ts',
	);
	return { ...actual, fetchFileBytes: vi.fn() };
});

import { fetchFileBytes } from '../../src/transport/httpFetch.ts';
import { updateFileFromUrl } from '../../src/tools/update-file-from-url.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { writingWiki } from '../helpers/writingWiki.ts';
import {
	contextUploadingTo,
	FILE_EXISTS,
	FILE_MISSING,
	UPLOADED,
} from '../helpers/uploadingWiki.ts';

const NEW_REVISION = {
	url: 'https://example.com/cat.jpg',
	title: 'File:Cat.jpg',
	comment: 'Higher res',
};

// A wiki holding the file, answering a copy-upload with `response`.
function wikiWithFile(response: object = { upload: UPLOADED }): ReturnType<typeof writingWiki> {
	return writingWiki(response, { read: FILE_EXISTS });
}

describe('update-file-from-url', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchFileBytes).mockResolvedValue(Buffer.from('IMG'));
	});

	it('returns not_found with routing hint when the file does not exist', async () => {
		const wiki = writingWiki({ upload: UPLOADED }, { read: FILE_MISSING });
		const uploadBytes = vi.fn();

		const result = await updateFileFromUrl.handle(
			{ url: 'https://example.com/cat.jpg', title: 'Cat.jpg' },
			contextUploadingTo(wiki, uploadBytes),
		);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toMatch(/Cat\.jpg/);
		expect(envelope.message).toMatch(/upload-file-from-url\b/);
		expect(uploadBytes).not.toHaveBeenCalled();
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('server-first: fetches the bytes and uploads them as a new revision with no page text', async () => {
		const wiki = wikiWithFile();
		const uploadBytes = vi.fn().mockResolvedValue(UPLOADED);

		const result = await updateFileFromUrl.handle(
			NEW_REVISION,
			contextUploadingTo(wiki, uploadBytes),
		);

		expect(assertStructuredSuccess(result)).toContain('Filename: Cat.jpg');
		expect(uploadBytes).toHaveBeenCalledWith(
			wiki.mwn,
			expect.any(Buffer),
			'Cat.jpg',
			'File:Cat.jpg',
			'',
			expect.objectContaining({
				ignorewarnings: true,
				comment: expect.stringMatching(/^Higher res.*update-file-from-url/),
			}),
		);
		expect(() => wiki.sentWrite()).toThrow('No write reached the wiki');
	});

	it('asks the wiki to fetch the new revision when the server cannot reach the URL', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const wiki = wikiWithFile();

		await updateFileFromUrl.handle(NEW_REVISION, contextUploadingTo(wiki, vi.fn()));

		const sent = wiki.sentWrite();
		expect(sent.get('action')).toBe('upload');
		expect(sent.get('url')).toBe('https://example.com/cat.jpg');
		expect(sent.get('filename')).toBe('File:Cat.jpg');
		expect(sent.get('text')).toBe('');
		expect(sent.get('ignorewarnings')).toBe('1');
		expect(sent.get('comment')).toMatch(/^Higher res.*update-file-from-url/);
	});

	it('reports an unrecognised failure with the standard verb prefix', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const wiki = wikiWithFile({ error: { code: 'somethingbroke', info: 'Boom' } });

		const result = await dispatch(
			updateFileFromUrl,
			contextUploadingTo(wiki, vi.fn()),
		)(NEW_REVISION);

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/^Failed to update file: .*Boom/);
	});

	it('reports a refused copy-upload as permission_denied', async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const wiki = wikiWithFile({
			error: { code: 'permissiondenied', info: 'You cannot reupload' },
		});

		const result = await dispatch(
			updateFileFromUrl,
			contextUploadingTo(wiki, vi.fn()),
		)(NEW_REVISION);

		assertStructuredError(result, 'permission_denied');
	});

	it("tags a copy-upload with the wiki's configured tags", async () => {
		vi.mocked(fetchFileBytes).mockRejectedValue(new FetchError('refused', 'system'));
		const wiki = wikiWithFile();

		await updateFileFromUrl.handle(NEW_REVISION, contextUploadingTo(wiki, vi.fn(), 'mcp-server'));

		expect(wiki.sentWrite().get('tags')).toBe('mcp-server');
	});
});
