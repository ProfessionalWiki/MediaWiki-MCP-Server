import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getFileData } from '../../src/tools/get-file-data.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredError } from '../helpers/structuredResult.js';

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
		const ctx = fakeContext({ mwn: async () => mock as never });

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

	it('preserves the image block through the dispatcher (no structuredContent clobber)', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = fakeContext({ mwn: async () => mock as never });

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
		const ctx = fakeContext({ mwn: async () => mock as never });

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
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFileData.handle({ title: 'Doc.pdf', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('get-file');
	});

	it('defaults width to 1024 in image mode and passes it to iiurlwidth', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1024 }));
	});

	it('clamps width to 1568', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getFileData.handle({ title: 'Example.png', width: 5000, format: 'image' }, ctx);

		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1568 }));
	});

	it('returns base64 in a text block when format is text', async () => {
		const mock = mwnWith(IMAGE_INFO);
		const ctx = fakeContext({ mwn: async () => mock as never });

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
		const ctx = fakeContext({ mwn: async () => mock as never });

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
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFileData.handle({ title: 'Sound.ogg', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('get-file');
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('rejects an over-cap payload with invalid_input mentioning width', async () => {
		vi.stubEnv('MCP_FILE_DATA_MAX_BYTES', '4');
		const mock = mwnWith(IMAGE_INFO);
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFileData.handle({ title: 'Example.png', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message.toLowerCase()).toContain('width');
	});

	it('returns not_found for a missing file', async () => {
		const mock = mwnWith({}, { missing: true });
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFileData.handle({ title: 'Missing.png', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('classifies upstream API failure via the dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

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
