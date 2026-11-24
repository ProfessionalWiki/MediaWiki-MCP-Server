import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ApiPage, ImageInfo } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { fileTitle } from '../wikis/fileTitle.ts';
import { wikiAuthorization } from '../wikis/wikiAuthorization.ts';
import { truncateByBytes } from '../results/truncation.ts';
import { structuredResult } from '../results/response.ts';
import { formatPayload } from '../results/format.ts';
import { extractPdfText } from '../results/pdfText.ts';

const DEFAULT_WIDTH = 1024;
const MAX_WIDTH = 1568;
const MAX_REDIRECTS = 5;
const MAX_SOURCE_BYTES = 10_000_000;

type FileKind = 'image' | 'svg' | 'text' | 'pdf';

const inputSchema = {
	title: z.string().describe('File title (with or without the "File:" prefix)'),
	format: z
		.enum(['auto', 'image', 'source', 'both'])
		.optional()
		.describe(
			"'auto' returns an image for raster and SVG files and text for text files and PDFs. 'image' returns only an image (PDFs are rejected). 'source' returns only decoded SVG XML, text, or extracted PDF text. 'both' returns every form the file supports.",
		),
	width: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Pixel width of the image rendition requested from the wiki; values above 1568 are clamped. The wiki decides whether it can render the file at that width.',
		),
} as const;

function kindOf(mime: string | undefined): FileKind | undefined {
	if (mime === undefined) {
		return undefined;
	}
	if (mime === 'image/svg+xml') {
		return 'svg';
	}
	if (mime.startsWith('image/')) {
		return 'image';
	}
	if (mime === 'application/pdf') {
		return 'pdf';
	}
	if (mime.startsWith('text/') || /[+-](json|xml)$/.test(mime)) {
		return 'text';
	}
	return undefined;
}

async function fetchBytes(
	mwn: Awaited<ReturnType<ToolContext['mwn']>>,
	url: string,
): Promise<{ bytes: Buffer; mime: string | undefined }> {
	const response = await mwn.rawRequest({
		url,
		method: 'GET',
		responseType: 'arraybuffer',
		maxRedirects: MAX_REDIRECTS,
		headers: wikiAuthorization(mwn, url),
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios arraybuffer body at this boundary
	const bytes = Buffer.from(response.data as ArrayBuffer);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios response headers at this boundary
	const headers = (response.headers ?? {}) as Record<string, unknown>;
	const raw = headers['content-type'];
	return {
		bytes,
		mime: typeof raw === 'string' ? raw.split(';')[0]?.trim().toLowerCase() : undefined,
	};
}

function sourcePayload(
	pageTitle: string,
	mime: string,
	kind: FileKind,
	bytes: Buffer,
): CallToolResult {
	const rawSource = kind === 'pdf' ? extractPdfText(bytes) : bytes.toString('utf8');
	const truncated = truncateByBytes(rawSource);
	const payload: Record<string, unknown> = {
		title: pageTitle,
		mime,
		source: truncated.text,
	};
	if (truncated.truncated) {
		payload.truncation = {
			reason: 'content-truncated',
			returnedBytes: truncated.returnedBytes,
			totalBytes: truncated.totalBytes,
			itemNoun: 'source',
			toolName: 'get-file-content',
			remedyHint:
				'To read the rest of this file, download it with get-file or raise MCP_CONTENT_MAX_BYTES; there is no narrower source read.',
		};
	}
	return structuredResult(payload);
}

export const getFileContent: Tool<typeof inputSchema> = {
	name: 'get-file-content',
	description:
		'Returns the content of a wiki file for model consumption: an image block for raster images and SVG, and decoded text for text-like files and PDFs. Use format to select image, source, or both; auto returns an image for raster and SVG and text for text files and PDFs. SVG and PDF image renditions come from the wiki, not local rasterisation. For metadata or a download URL, use get-file; for a scaled image only, use get-file-data. Non-renderable types (audio, video, binaries) return an error. Text sources are truncated at 75000 bytes by default, with a marker reporting how much was returned; there is no narrower source read.',
	inputSchema,
	annotations: {
		title: 'Get file content',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'retrieve file content',
	target: (a) => a.title,

	async handle({ title, format, width }, ctx: ToolContext): Promise<CallToolResult> {
		const selectedFormat = format ?? 'auto';
		const effectiveWidth = Math.min(width ?? DEFAULT_WIDTH, MAX_WIDTH);
		const mwn = await ctx.mwn();
		const response = await mwn.request({
			action: 'query',
			titles: fileTitle(title),
			prop: 'imageinfo',
			iiprop: 'url|size|mime',
			iiurlwidth: effectiveWidth,
			formatversion: '2',
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const page = response.query?.pages?.[0] as ApiPage | undefined;
		// A file on a shared repository such as Commons has no local page, but its
		// imageinfo still describes the file.
		const info: ImageInfo | undefined = page?.imageinfo?.[0];
		if (page === undefined || info === undefined) {
			return ctx.format.notFound(`File "${title}" not found`);
		}
		const mime = info.mime ?? '';
		const kind = kindOf(mime);
		if (kind === undefined) {
			return ctx.format.invalidInput(
				`File "${title}" (${mime === '' ? 'unknown type' : mime}) has no text or image content. Use get-file for its metadata and download URL.`,
			);
		}
		const wantsImage =
			selectedFormat === 'auto' ? kind === 'image' || kind === 'svg' : selectedFormat !== 'source';
		const wantsSource =
			selectedFormat === 'auto' ? kind === 'text' || kind === 'pdf' : selectedFormat !== 'image';
		if (selectedFormat === 'image' && kind === 'pdf') {
			return ctx.format.invalidInput(
				`File "${title}" is a PDF; its content is text. Use format='source' (or 'auto'/'both') to read it.`,
			);
		}
		if (wantsSource && kind === 'image') {
			return ctx.format.invalidInput(
				`File "${title}" is a raster image and has no source text. Use format='image'.`,
			);
		}

		const thumb = info as ImageInfo & { thumburl?: string };
		const imageUrl = thumb.thumburl ?? (kind === 'image' ? info.url : undefined);
		if (wantsImage && imageUrl === undefined) {
			return ctx.format.invalidInput(
				`File "${title}" has no image rendition at ${effectiveWidth}px. Request a smaller width or use format='source'.`,
			);
		}
		if (wantsSource && info.url === undefined) {
			return ctx.format.notFound(`File "${title}" has no download URL`);
		}

		const pageTitle = page.title ?? fileTitle(title);
		// Source-only responses use the shared formatter for both the prose and
		// structured channels. Mixing an image block with structuredContent is not
		// safe: the dispatcher re-wraps plain structured payloads into one text
		// block, which would drop the image. Mixed responses therefore carry the
		// source as a text block and no structuredContent.
		if (!wantsImage) {
			const fetched = await fetchBytes(mwn, info.url!);
			if (fetched.bytes.length > MAX_SOURCE_BYTES) {
				return ctx.format.invalidInput(
					`File "${title}" is over the ${MAX_SOURCE_BYTES}-byte source limit. Download it with get-file instead.`,
				);
			}
			return sourcePayload(pageTitle, mime, kind, fetched.bytes);
		}

		const content: CallToolResult['content'] = [];
		const image = await fetchBytes(mwn, imageUrl!);
		if (!image.mime?.startsWith('image/')) {
			return ctx.format.invalidInput(
				`The rendition of "${title}" is not an image (${image.mime ?? 'unknown type'}). Request a smaller width or use format='source'.`,
			);
		}
		if (wantsSource) {
			const fetched = await fetchBytes(mwn, info.url!);
			if (fetched.bytes.length > MAX_SOURCE_BYTES) {
				return ctx.format.invalidInput(
					`File "${title}" is over the ${MAX_SOURCE_BYTES}-byte source limit. Download it with get-file instead.`,
				);
			}
			const source = sourcePayload(pageTitle, mime, kind, fetched.bytes);
			content.push(source.content[0]);
		}
		content.push({
			type: 'image',
			data: image.bytes.toString('base64'),
			mimeType: image.mime,
		});
		if (!wantsSource) {
			content.unshift({
				type: 'text',
				text: formatPayload({ title: pageTitle, mime, width: effectiveWidth, wiki: ctx.wiki.key }),
			});
		}
		return { content };
	},
};
