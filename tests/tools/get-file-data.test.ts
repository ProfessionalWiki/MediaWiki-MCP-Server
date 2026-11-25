import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/server';
import { createMockMwn, type MockMwn } from '../helpers/mock-mwn.ts';
import { contextOn } from '../helpers/fakeContext.ts';
import { getFileData } from '../../src/tools/get-file-data.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.ts';
import { rejectionOf } from '../helpers/rejectionOf.ts';

// Build an action=query&prop=imageinfo response. `info` is the imageinfo[0]
// object; pass `missing: true` for a missing-page response.
function imageinfoResponse(
	info: Record<string, unknown>,
	opts: { missing?: boolean } = {},
): unknown {
	return {
		query: {
			pages: [
				opts.missing
					? { title: 'File:Missing.png', missing: true }
					: { title: 'File:Example.png', imageinfo: [info] },
			],
		},
	};
}

const IMAGE_INFO = {
	url: 'https://test.wiki/images/example.png',
	descriptionurl: 'https://test.wiki/wiki/File:Example.png',
	size: 12345,
	width: 800,
	height: 600,
	mime: 'image/png',
	thumburl: 'https://test.wiki/images/thumb/example.png/1024px-example.png',
	thumbwidth: 1024,
	thumbheight: 768,
};

const FAKE_BYTES = Buffer.from('fake-image-bytes');

function mwnWith(info: Record<string, unknown>, opts: { missing?: boolean } = {}) {
	return createMockMwn({
		request: vi.fn().mockResolvedValue(imageinfoResponse(info, opts)),
		rawRequest: vi.fn().mockResolvedValue({
			data: FAKE_BYTES,
			headers: { 'content-type': 'image/png' },
		}),
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('get-file-data', () => {
	it('returns an image content block for a renderable image', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(2);
		const caption = result.content[0] as TextContent;
		const payload = result.content[1] as ImageContent;
		expect(caption.type).toBe('text');
		expect(caption.text).toContain('test-wiki');
		expect(caption.text).toContain('image/png');
		expect(caption.text).toContain('1024×768');
		expect(payload.type).toBe('image');
		expect(payload.mimeType).toBe('image/png');
		expect(payload.data).toBe(FAKE_BYTES.toString('base64'));
		expect(mock.rawRequest).toHaveBeenCalledWith(
			expect.objectContaining({ url: IMAGE_INFO.thumburl, responseType: 'arraybuffer' }),
		);
	});

	it("names the image's type without the response's content-type parameters", async () => {
		const mock = mwnWith(IMAGE_INFO);
		mock.rawRequest.mockResolvedValue({
			data: FAKE_BYTES,
			headers: { 'content-type': 'image/png; charset=binary' },
		});

		const result = await getFileData.handle(
			{ title: 'Example.png', format: 'image' },
			contextOn(mock),
		);

		expect((result.content[1] as ImageContent).mimeType).toBe('image/png');
	});

	it("looks up a title with a File prefix in the wiki's language as given", async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		await getFileData.handle({ title: 'Datei:Example.png', format: 'image' }, ctx);

		expect((mock.request.mock.calls[0][0] as { titles: string }).titles).toBe('Datei:Example.png');
	});

	it('attaches the OAuth2 bearer when the file is same-origin as the wiki API', async () => {
		const mock = mwnWith(IMAGE_INFO);
		mock.usingOAuth2 = true;
		mock.options = { apiUrl: 'https://test.wiki/w/api.php', OAuth2AccessToken: 'secret-token' };
		const ctx = contextOn(mock);

		await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect(mock.rawRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
			}),
		);
	});

	it('does not leak the bearer to a different-origin file host', async () => {
		const mock = mwnWith({
			...IMAGE_INFO,
			thumburl: 'https://cdn.example.org/thumb/example.png/1024px-example.png',
		});
		mock.usingOAuth2 = true;
		mock.options = { apiUrl: 'https://test.wiki/w/api.php', OAuth2AccessToken: 'secret-token' };
		const ctx = contextOn(mock);

		await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		const firstCallArg = mock.rawRequest.mock.calls[0][0] as { headers?: Record<string, string> };
		expect(firstCallArg.headers?.Authorization).toBeUndefined();
	});

	it('preserves the image block through the dispatcher (no structuredContent clobber)', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		const result = await dispatch(
			getFileData,
			ctx,
		)({
			title: 'Example.png',
			format: 'image',
		});

		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe('text');
		const payload = result.content[1] as ImageContent;
		expect(payload.type).toBe('image');
		expect(payload.data).toBe(FAKE_BYTES.toString('base64'));
		// Dispatcher resolved the default wiki; the caption carries it (there is no
		// structuredContent for the wiki-echo to re-wrap, so the image block survives).
		expect((result.content[0] as TextContent).text).toContain('test-wiki');
	});

	it('falls back to the original mime when the response has no content-type', async () => {
		const mock = mwnWith(IMAGE_INFO);
		mock.rawRequest = vi.fn().mockResolvedValue({ data: FAKE_BYTES, headers: {} });
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect(result.isError).toBeFalsy();
		const payload = result.content[1] as ImageContent;
		expect(payload.type).toBe('image');
		expect(payload.mimeType).toBe('image/png');
	});

	it('rejects when fetched bytes are not an image and the original is non-image', async () => {
		// A PDF with a thumburl, but the fetch returned an HTML error page.
		const mock = mwnWith({
			url: 'https://test.wiki/images/doc.pdf',
			size: 99999,
			mime: 'application/pdf',
			thumburl: 'https://test.wiki/images/thumb/doc.pdf/1024px-doc.pdf.jpg',
			thumbwidth: 1024,
			thumbheight: 1320,
		});
		mock.rawRequest = vi.fn().mockResolvedValue({
			data: Buffer.from('<html>error</html>'),
			headers: { 'content-type': 'text/html' },
		});
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Doc.pdf', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('get-file');
	});

	it('defaults width to 1024 in image mode and passes it to iiurlwidth', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1024 }));
	});

	it('clamps width to 1568', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		await getFileData.handle({ title: 'Example.png', width: 5000, format: 'image' }, ctx);

		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1568 }));
	});

	it('returns base64 in a text block when format is text', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Example.png', format: 'text' }, ctx);

		expect(result.isError).toBeFalsy();
		const payload = result.content[1] as TextContent;
		expect(payload.type).toBe('text');
		expect(payload.text).toBe(FAKE_BYTES.toString('base64'));
		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 512 }));
	});

	it('renders a non-image file via its thumburl', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/doc.pdf',
			size: 99999,
			mime: 'application/pdf',
			thumburl: 'https://test.wiki/images/thumb/doc.pdf/1024px-doc.pdf.jpg',
			thumbwidth: 1024,
			thumbheight: 1320,
		});
		mock.rawRequest = vi.fn().mockResolvedValue({
			data: FAKE_BYTES,
			headers: { 'content-type': 'image/jpeg' },
		});
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Doc.pdf', format: 'image' }, ctx);

		expect(result.isError).toBeFalsy();
		const payload = result.content[1] as ImageContent;
		expect(payload.type).toBe('image');
		expect(payload.mimeType).toBe('image/jpeg');
	});

	it('rejects a non-renderable file with invalid_input pointing to get-file', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/sound.ogg',
			size: 4242,
			mime: 'audio/ogg',
		});
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Sound.ogg', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('get-file');
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('rejects an over-cap payload with invalid_input mentioning width', async () => {
		vi.stubEnv('MCP_FILE_DATA_MAX_BYTES', '4');
		const mock = mwnWith(IMAGE_INFO);
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message.toLowerCase()).toContain('width');
	});

	it('returns a file the wiki serves from a shared repository such as Commons', async () => {
		const mock = mwnWith(IMAGE_INFO);
		mock.request.mockResolvedValue({
			query: {
				pages: [
					{
						title: 'File:Example.png',
						missing: true,
						known: true,
						imagerepository: 'shared',
						imageinfo: [IMAGE_INFO],
					},
				],
			},
		});
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect((result.content[1] as ImageContent).data).toBe(FAKE_BYTES.toString('base64'));
	});

	it('returns not_found for a missing file', async () => {
		const mock = mwnWith({}, { missing: true });
		const ctx = contextOn(mock);

		const result = await getFileData.handle({ title: 'Missing.png', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('classifies upstream API failure via the dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = contextOn(mock);

		const result = await dispatch(
			getFileData,
			ctx,
		)({
			title: 'Example.png',
			format: 'image',
		});

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});
});

const ORIGINAL_URL = 'https://test.wiki/images/a/ab/Diagram.svg';

// A file of `size` bytes whose original, and only its original, downloads as `body`.
function streamingFileMwn(mime: string, size: number, body: () => Readable): MockMwn {
	return createMockMwn({
		request: vi.fn().mockResolvedValue({
			query: {
				pages: [
					{
						title: 'File:Diagram.svg',
						imageinfo: [
							{
								url: ORIGINAL_URL,
								mime,
								size,
								thumburl: 'https://test.wiki/images/thumb/a/ab/Diagram.svg/200px-Diagram.svg.png',
							},
						],
					},
				],
			},
		}),
		rawRequest: vi.fn(async ({ url }: { url: string }) => {
			if (url !== ORIGINAL_URL) {
				throw new Error(`unexpected download of ${url}`);
			}
			return { data: body(), headers: { 'content-type': mime } };
		}),
	});
}

function originalFileMwn(mime: string, bytes: Buffer): MockMwn {
	return streamingFileMwn(mime, bytes.byteLength, () => Readable.from([bytes]));
}

function getOriginalFileFrom(mock: MockMwn): Promise<CallToolResult> {
	return getFileData.handle({ title: 'Diagram.svg', format: 'original' }, contextOn(mock));
}

function getOriginalFile(mime: string, bytes: Buffer): Promise<CallToolResult> {
	return getOriginalFileFrom(originalFileMwn(mime, bytes));
}

describe("get-file-data with format 'original'", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		'image/svg+xml',
		'text/plain',
		'text/csv',
		'application/json',
		'application/ld+json',
		'application/xml',
		'text/html',
	])('returns the original contents of a %s file beside its metadata', async (mime) => {
		const contents = '<svg xmlns="http://www.w3.org/2000/svg">é</svg>';

		const result = await getOriginalFile(mime, Buffer.from(contents, 'utf8'));

		expect(assertStructuredData(result)).toMatchObject({ mime, originalFile: contents });
	});

	it.each(['image/png', 'application/pdf', 'font/woff2'])(
		'refuses the original contents of a %s file, naming its type',
		async (mime) => {
			const result = await getOriginalFile(mime, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

			expect(assertStructuredError(result, 'invalid_input').message).toContain(mime);
		},
	);

	it("points a text file asked for as an image to format 'original'", async () => {
		const mock = originalFileMwn('application/json', Buffer.from('{}'));
		mock.request.mockResolvedValue({
			query: {
				pages: [
					{
						title: 'File:Data.json',
						imageinfo: [{ url: ORIGINAL_URL, mime: 'application/json', size: 2 }],
					},
				],
			},
		});

		const result = await getFileData.handle(
			{ title: 'Data.json', format: 'image' },
			contextOn(mock),
		);

		expect(assertStructuredError(result, 'invalid_input').message).toContain("format='original'");
	});

	it('refuses an HTML page served in place of the file', async () => {
		const mock = originalFileMwn('image/svg+xml', Buffer.from('<svg/>'));
		mock.rawRequest.mockResolvedValue({
			data: Readable.from([Buffer.from('<!DOCTYPE html><title>Log in</title>')]),
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});

		const result = await getOriginalFileFrom(mock);

		assertStructuredError(result, 'invalid_input');
	});

	it('keeps a byte-order mark at the start of the file', async () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b')]);

		const result = await getOriginalFile('text/csv', bytes);

		expect(assertStructuredData(result).originalFile).toBe('\uFEFFa,b');
	});

	it('asks the wiki for no rendition when reading the original file', async () => {
		const mock = originalFileMwn('image/svg+xml', Buffer.from('<svg/>'));

		await getOriginalFileFrom(mock);

		expect(mock.request.mock.calls[0][0]).not.toHaveProperty('iiurlwidth');
	});

	it('releases the connection of a download the wiki refuses', async () => {
		const mock = originalFileMwn('image/svg+xml', Buffer.from('<svg/>'));
		const body = Readable.from([Buffer.from('Forbidden')]);
		mock.rawRequest.mockRejectedValue(
			Object.assign(new Error('Request failed with status code 403'), {
				response: { status: 403, data: body },
			}),
		);

		await rejectionOf(getOriginalFileFrom(mock));

		expect(body.destroyed).toBe(true);
	});

	it('refuses a text file whose bytes are not UTF-8', async () => {
		const latin1 = Buffer.from('caf\xe9', 'latin1');

		const result = await getOriginalFile('text/plain', latin1);

		assertStructuredError(result, 'invalid_input');
	});

	it('carries no truncation marker when the contents fit the budget', async () => {
		const result = await getOriginalFile('text/plain', Buffer.from('short'));

		expect(assertStructuredData(result)).not.toHaveProperty('truncation');
	});

	it("downloads the original file with the wiki's OAuth token", async () => {
		const mock = originalFileMwn('image/svg+xml', Buffer.from('<svg/>'));
		mock.usingOAuth2 = true;
		mock.options = { apiUrl: 'https://test.wiki/w/api.php', OAuth2AccessToken: 'secret-token' };

		await getOriginalFileFrom(mock);

		expect(mock.rawRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
			}),
		);
	});

	it('stops downloading once it has more than it can return', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '10');
		const body = (): Readable =>
			Readable.from(
				(function* () {
					yield Buffer.from('a'.repeat(15));
					throw new Error('read past the returned prefix');
				})(),
			);
		const mock = streamingFileMwn('text/plain', 1_000_000, body);

		const result = await getOriginalFileFrom(mock);

		expect(assertStructuredData(result)).toMatchObject({
			originalFile: 'a'.repeat(10),
			truncation: { returnedBytes: 10, totalBytes: 1_000_000 },
		});
	});

	it('returns the start of a file whose bytes past the cut are not UTF-8', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '10');
		const bytes = Buffer.concat([Buffer.from('a'.repeat(20)), Buffer.from([0xff])]);

		const result = await getOriginalFile('text/plain', bytes);

		expect(assertStructuredData(result).originalFile).toBe('a'.repeat(10));
	});

	it('cuts before a character that straddles the budget', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '10');

		const result = await getOriginalFile('text/plain', Buffer.from(`${'a'.repeat(9)}é and more`));

		expect(assertStructuredData(result)).toMatchObject({
			originalFile: 'a'.repeat(9),
			truncation: { returnedBytes: 9 },
		});
	});

	it('cuts contents over the content budget and marks how much was returned', async () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '10');

		const result = await getOriginalFile('text/plain', Buffer.from('a'.repeat(25)));

		expect(assertStructuredData(result)).toMatchObject({
			originalFile: 'a'.repeat(10),
			truncation: { reason: 'content-truncated', returnedBytes: 10, totalBytes: 25 },
		});
	});
});
