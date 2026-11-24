import { describe, it, expect, vi, afterEach } from 'vitest';
import { deflateSync } from 'node:zlib';
import type { ImageContent, TextContent } from '@modelcontextprotocol/server';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { contextOn } from '../helpers/fakeContext.ts';
import { getFileContent } from '../../src/tools/get-file-content.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const TEXT_BYTES = Buffer.from('Hello from a wiki text file.\n', 'utf8');
const PDF_TEXT = 'BT (A wiki PDF paragraph) Tj ( with a second string) Tj ET';
const PDF_BYTES = Buffer.from(
	`%PDF-1.4\n1 0 obj\n<< /Length 1 >>\nstream\n${deflateSync(PDF_TEXT).toString('latin1')}\nendstream\nendobj\n%%EOF\n`,
	'latin1',
);

function imageinfoResponse(
	info: Record<string, unknown>,
	opts: { missing?: boolean } = {},
): unknown {
	return {
		query: {
			pages: [
				opts.missing
					? { title: 'File:Missing.png', missing: true }
					: { title: info.title ?? 'File:Example.png', imageinfo: [info] },
			],
		},
	};
}

function mwnWith(
	info: Record<string, unknown>,
	body: Buffer = PNG_BYTES,
	contentType = 'image/png',
) {
	return createMockMwn({
		request: vi.fn().mockResolvedValue(imageinfoResponse(info)),
		rawRequest: vi.fn().mockResolvedValue({ data: body, headers: { 'content-type': contentType } }),
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('get-file-content', () => {
	it('returns an image block for a raster image in auto mode', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/example.png',
			mime: 'image/png',
			width: 800,
			height: 600,
		});
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Example.png' }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content).toHaveLength(2);
		expect((result.content[0] as TextContent).text).toContain('image/png');
		const payload = result.content[1] as ImageContent;
		expect(payload.type).toBe('image');
		expect(payload.data).toBe(PNG_BYTES.toString('base64'));
		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1024 }));
	});

	it('clamps width to 1568', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/example.png',
			mime: 'image/png',
		});
		const ctx = contextOn(mock);

		await getFileContent.handle({ title: 'Example.png', width: 5000, format: 'image' }, ctx);

		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 1568 }));
	});

	it('requests a thumbnail from the wiki for raster and SVG images', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/example.svg',
			mime: 'image/svg+xml',
			thumburl: 'https://test.wiki/images/thumb/example.svg/800px-example.svg.png',
			thumbwidth: 800,
			thumbheight: 600,
		});
		mock.rawRequest = vi
			.fn()
			.mockResolvedValueOnce({ data: PNG_BYTES, headers: { 'content-type': 'image/png' } })
			.mockResolvedValueOnce({
				data: Buffer.from('<svg></svg>'),
				headers: { 'content-type': 'image/svg+xml' },
			});
		const ctx = contextOn(mock);

		const result = await getFileContent.handle(
			{ title: 'Example.svg', format: 'both', width: 800 },
			ctx,
		);

		expect(result.isError).toBeFalsy();
		const blocks = result.content.filter((block) => block.type === 'image') as ImageContent[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0].data).toBe(PNG_BYTES.toString('base64'));
		expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ iiurlwidth: 800 }));
	});

	it('returns decoded SVG XML in source mode', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Example</title></svg>';
		const mock = mwnWith(
			{
				title: 'File:Example.svg',
				url: 'https://test.wiki/images/example.svg',
				mime: 'image/svg+xml',
			},
			Buffer.from(svg, 'utf8'),
			'image/svg+xml',
		);
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Example.svg', format: 'source' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({ title: 'File:Example.svg', mime: 'image/svg+xml', source: svg }),
		);
	});

	it('returns decoded text in source mode', async () => {
		const mock = mwnWith(
			{
				title: 'File:Example.txt',
				url: 'https://test.wiki/images/example.txt',
				mime: 'text/plain',
			},
			TEXT_BYTES,
			'text/plain; charset=utf-8',
		);
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Example.txt', format: 'source' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain(TEXT_BYTES.toString('utf8').trim());
		expect(text).toContain('text/plain');
	});

	it('extracts PDF text in source mode', async () => {
		const mock = mwnWith(
			{
				title: 'File:Doc.pdf',
				url: 'https://test.wiki/images/doc.pdf',
				mime: 'application/pdf',
			},
			PDF_BYTES,
			'application/pdf',
		);
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Doc.pdf', format: 'source' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('A wiki PDF paragraph');
		expect(text).toContain('application/pdf');
	});

	it('returns every supported form in both mode', async () => {
		const mock = mwnWith(
			{
				title: 'File:Doc.pdf',
				url: 'https://test.wiki/images/doc.pdf',
				mime: 'application/pdf',
				thumburl: 'https://test.wiki/images/thumb/doc.pdf/1024px-doc.pdf.jpg',
				thumbwidth: 1024,
				thumbheight: 1320,
			},
			PDF_BYTES,
			'application/pdf',
		);
		mock.rawRequest = vi
			.fn()
			.mockResolvedValueOnce({ data: PNG_BYTES, headers: { 'content-type': 'image/jpeg' } })
			.mockResolvedValueOnce({ data: PDF_BYTES, headers: { 'content-type': 'application/pdf' } });
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Doc.pdf', format: 'both' }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content.filter((block) => block.type === 'image')).toHaveLength(1);
		const text = result.content.find((block) => block.type === 'text') as TextContent;
		expect(text.text).toContain('A wiki PDF paragraph');
	});

	it('rejects PDFs in image mode with a pointer to source', async () => {
		const mock = mwnWith({
			title: 'File:Doc.pdf',
			url: 'https://test.wiki/images/doc.pdf',
			mime: 'application/pdf',
		});
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Doc.pdf', format: 'image' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('format');
		expect(envelope.message).toContain('source');
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('rejects non-renderable files with a pointer to get-file', async () => {
		const mock = mwnWith(
			{
				title: 'File:Sound.ogg',
				url: 'https://test.wiki/images/sound.ogg',
				mime: 'audio/ogg',
			},
			Buffer.from('ogg'),
			'audio/ogg',
		);
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Sound.ogg', format: 'auto' }, ctx);

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toContain('get-file');
	});

	it('returns not_found for a missing file', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue(imageinfoResponse({}, { missing: true })),
		});
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Missing.png' }, ctx);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('respects the shared content byte budget and reports a truncation marker', async () => {
		const svg = '<svg>' + 'x'.repeat(40) + '</svg>';
		const mock = mwnWith(
			{
				title: 'File:Example.svg',
				url: 'https://test.wiki/images/example.svg',
				mime: 'image/svg+xml',
			},
			Buffer.from(svg, 'utf8'),
			'image/svg+xml',
		);
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '30');
		const ctx = contextOn(mock);

		const result = await getFileContent.handle({ title: 'Example.svg', format: 'source' }, ctx);

		const payload = result.structuredContent as Record<string, unknown>;
		const truncation = payload.truncation as Record<string, unknown>;
		expect(truncation.reason).toBe('content-truncated');
		expect(truncation.toolName).toBe('get-file-content');
		expect(truncation.itemNoun).toBe('source');
		expect(truncation.returnedBytes).toBe(30);
		expect(truncation.totalBytes).toBe(Buffer.byteLength(svg, 'utf8'));
		expect(truncation.remedyHint).toContain('narrower');
	});

	it('preserves the image block through the dispatcher', async () => {
		const mock = mwnWith({
			url: 'https://test.wiki/images/example.png',
			mime: 'image/png',
		});
		const ctx = contextOn(mock);

		const result = await dispatch(getFileContent, ctx)({ title: 'Example.png' });

		expect(result.isError).toBeFalsy();
		const payload = result.content[1] as ImageContent;
		expect(payload.type).toBe('image');
		expect(payload.data).toBe(PNG_BYTES.toString('base64'));
	});

	it('classifies upstream API failure via the dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = contextOn(mock);

		const result = await dispatch(getFileContent, ctx)({ title: 'Example.png' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});
});
