import { z } from 'zod';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/server';
import type { ApiPage, ImageInfo, Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { fileTitle } from '../wikis/fileTitle.ts';
import { downloadFile, downloadFilePrefix } from '../wikis/downloadFile.ts';
import { contentMaxBytes, truncateUtf8, type TruncationInfo } from '../results/truncation.ts';

const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_TEXT_WIDTH = 512;
const MAX_WIDTH = 1568;
const DEFAULT_FILE_DATA_MAX_BYTES = 1_000_000;

const TRUNCATED_REMEDY =
	'No narrower read of a file is available. To read the whole file, download it from its url.';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Operator-owned transport/safety backstop on the encoded payload size. Distinct
// from MCP_CONTENT_MAX_BYTES (a text-body cap) — binary can't be truncated, so
// over-cap is a hard error, not a trailing marker.
function resolveFileDataMaxBytes(): number {
	const raw = process.env.MCP_FILE_DATA_MAX_BYTES;
	if (raw === undefined || raw === '') {
		return DEFAULT_FILE_DATA_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_FILE_DATA_MAX_BYTES;
	}
	return parsed;
}

const inputSchema = {
	title: z.string().describe('File title (with or without the "File:" prefix)'),
	width: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Pixel width of the scaled rendition, for the image and text formats. A quality/detail knob: in image mode the model caps image tokens regardless of size, so larger mainly means more detail. Defaults to 1024 (512 when format is "text"); values above 1568 are clamped.',
		),
	format: z
		.enum(['image', 'text', 'original'])
		.default('image')
		.describe(
			"'image' returns the wiki's rendering of the file as a native image content block the model can view; 'text' returns that rendering's base64 as a text block, for hosts that do not forward image content to the model (base64 text costs far more tokens); 'original' returns the original file's contents as text, for text-based files such as SVG, plain text, JSON or XML. The original file is the upload itself, not its file description page; for that page's wikitext, use get-page.",
		),
} as const;

export const getFileData: Tool<typeof inputSchema> = {
	name: 'get-file-data',
	description:
		'Fetches a wiki file server-side and returns its content inline, for clients that cannot reach the wiki host (sandboxed or network-restricted). By default returns a scaled rendition sized by width, as an image the model can view: files MediaWiki can rasterize (images, SVG, PDF, DjVu) come back as an image. With format original, returns the contents of a text-based original file, such as SVG, JSON or XML, truncated at 75000 bytes by default. Other types (audio, video, arbitrary binaries) error; for those, and for metadata or a download URL, use get-file.',
	inputSchema,
	annotations: {
		title: 'Get file data',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'fetch the file',
	target: (a) => a.title,

	async handle({ title, width, format }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const effectiveWidth = Math.min(
			width ?? (format === 'text' ? DEFAULT_TEXT_WIDTH : DEFAULT_IMAGE_WIDTH),
			MAX_WIDTH,
		);

		const response = await mwn.request({
			action: 'query',
			titles: fileTitle(title),
			prop: 'imageinfo',
			iiprop: 'url|size|mime',
			// A rendition the original format does not use would still be rendered for the request.
			...(format === 'original' ? {} : { iiurlwidth: effectiveWidth }),
			formatversion: '2',
		});

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const page = response.query?.pages?.[0] as ApiPage | undefined;
		// A file served from a shared repository such as Commons has no page on
		// this wiki, so the wiki calls it missing while still describing the file.
		const info: ImageInfo | undefined = page?.imageinfo?.[0];
		if (page === undefined || info === undefined) {
			return ctx.format.notFound(`File "${title}" not found`);
		}

		if (format === 'original') {
			return originalFileResult(mwn, title, page, info, ctx);
		}
		return renditionResult(mwn, title, page, info, format, ctx);
	},
};

async function renditionResult(
	mwn: Mwn,
	title: string,
	page: ApiPage,
	info: ImageInfo,
	format: 'image' | 'text',
	ctx: ToolContext,
): Promise<CallToolResult> {
	// Let MediaWiki decide renderability: a thumburl means it rasterized the
	// file (image, SVG, PDF page, DjVu...) to an image. Otherwise only a file
	// that is itself an image can be fetched directly (it was too small to
	// scale). Anything else is non-renderable.
	const thumb = info as ImageInfo & {
		thumburl?: string;
		thumbwidth?: number;
		thumbheight?: number;
	};
	const isImageMime = typeof info.mime === 'string' && info.mime.startsWith('image/');
	let fetchUrl: string | undefined;
	if (typeof thumb.thumburl === 'string' && thumb.thumburl !== '') {
		fetchUrl = thumb.thumburl;
	} else if (isImageMime) {
		fetchUrl = info.url;
	}
	if (fetchUrl === undefined) {
		const remedy = isTextBased(info.mime)
			? "For its original contents as text, use format='original'."
			: 'Use get-file for its download URL.';
		return ctx.format.invalidInput(
			`File "${title}" (${info.mime ?? 'unknown type'}) cannot be rendered as an image. ${remedy}`,
		);
	}

	const { bytes, contentType } = await downloadFile(mwn, fetchUrl);

	// The block's mime is the fetched bytes' type (a PDF thumb is image/jpeg),
	// falling back to the original mime for a directly-fetched image. Assert it
	// really is an image before emitting an image block.
	const mimeType =
		contentType !== undefined && contentType.startsWith('image/')
			? contentType
			: isImageMime
				? info.mime
				: undefined;
	if (mimeType === undefined) {
		return ctx.format.invalidInput(
			`Fetched data for "${title}" is not an image (${contentType ?? info.mime ?? 'unknown type'}). Use get-file for its download URL.`,
		);
	}

	const base64 = bytes.toString('base64');
	const maxBytes = resolveFileDataMaxBytes();
	if (base64.length > maxBytes) {
		return ctx.format.invalidInput(
			`Encoded file data is ${base64.length} bytes, over the ${maxBytes}-byte limit (MCP_FILE_DATA_MAX_BYTES). Request a smaller width.`,
		);
	}

	const wikiKey = ctx.wiki.key;
	const renderedWidth = thumb.thumbwidth ?? info.width;
	const renderedHeight = thumb.thumbheight ?? info.height;
	const dims =
		renderedWidth !== undefined && renderedHeight !== undefined
			? `${renderedWidth}×${renderedHeight}`
			: 'unknown size';
	const sizeKb = Math.max(1, Math.round(base64.length / 1024));
	const caption: TextContent = {
		type: 'text',
		text: `File: ${page.title} • Wiki: ${wikiKey} • Type: ${mimeType} • Returned ${dims}, ${sizeKb} KB encoded`,
	};
	const payload: ImageContent | TextContent =
		format === 'text' ? { type: 'text', text: base64 } : { type: 'image', data: base64, mimeType };

	// No structuredContent: the dispatcher echoes the wiki key by re-wrapping a
	// plain-object structuredContent into a single text block, which would drop
	// the image block. The wiki key is in the caption instead.
	return { content: [caption, payload] };
}

async function originalFileResult(
	mwn: Mwn,
	title: string,
	page: ApiPage,
	info: ImageInfo,
	ctx: ToolContext,
): Promise<CallToolResult> {
	if (!isTextBased(info.mime)) {
		return ctx.format.invalidInput(
			`Original file contents are returned only for text-based files, such as SVG, plain text, JSON or XML, and "${title}" is ${info.mime ?? 'of unknown type'}. For a rendering to look at, use format='image'; for its download URL, use get-file.`,
		);
	}
	if (info.url === undefined) {
		return ctx.format.notFound(`File "${title}" not found`);
	}
	// One byte past the budget tells a file that fits from one that does not.
	const budget = contentMaxBytes();
	const head = await downloadFilePrefix(mwn, info.url, budget + 1);
	if (head.contentType === 'text/html' && info.mime !== 'text/html') {
		return ctx.format.invalidInput(
			`Fetched data for "${title}" is an HTML page, not the ${info.mime} file, as a login or error page would be. Use get-file for its download URL.`,
		);
	}
	const original = originalFilePayload(head.bytes, budget, info.size);
	if (original === undefined) {
		return ctx.format.invalidInput(
			`"${title}" is not UTF-8 text, so its original contents cannot be returned as text. For its download URL, use get-file.`,
		);
	}
	return ctx.format.ok({
		title: page.title,
		mime: info.mime,
		size: info.size,
		url: info.url,
		...original,
	});
}

function isTextBased(mime: string | undefined): boolean {
	if (mime === undefined) {
		return false;
	}
	return (
		mime.startsWith('text/') ||
		mime === 'application/json' ||
		mime === 'application/xml' ||
		/\+(json|xml)$/.test(mime)
	);
}

/** The start of the original file that fits the content budget, or undefined when it is not UTF-8. */
function originalFilePayload(
	head: Buffer,
	budget: number,
	size: number | undefined,
): { originalFile: string; truncation?: TruncationInfo } | undefined {
	const cut = truncateUtf8(head, budget);
	const contents = decodeUtf8(cut.bytes);
	if (contents === undefined) {
		return undefined;
	}
	return {
		originalFile: contents,
		...(cut.truncated
			? { truncation: contentTruncation(cut.returnedBytes, size ?? head.length) }
			: {}),
	};
}

function decodeUtf8(bytes: Buffer): string | undefined {
	try {
		return UTF8.decode(bytes);
	} catch {
		return undefined;
	}
}

function contentTruncation(returnedBytes: number, totalBytes: number): TruncationInfo {
	return {
		reason: 'content-truncated',
		returnedBytes,
		totalBytes,
		itemNoun: 'original file',
		toolName: 'get-file-data',
		remedyHint: TRUNCATED_REMEDY,
	};
}
