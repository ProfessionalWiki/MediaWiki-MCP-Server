import { z } from 'zod';
import type {
	CallToolResult,
	ToolAnnotations,
	ImageContent,
	TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApiPage, ImageInfo } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';

const DEFAULT_IMAGE_WIDTH = 1024;
const DEFAULT_TEXT_WIDTH = 512;
const MAX_WIDTH = 1568;
const DEFAULT_FILE_DATA_MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

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
			'Pixel width of the scaled rendition. A quality/detail knob: in image mode the model caps image tokens regardless of size, so larger mainly means more detail. Defaults to 1024 (512 when format is "text"); values above 1568 are clamped.',
		),
	format: z
		.enum(['image', 'text'])
		.default('image')
		.describe(
			"'image' returns a native image content block the model can view; 'text' returns the base64 as a text block, for hosts that do not forward image content to the model (base64 text costs far more tokens).",
		),
} as const;

export const getFileData: Tool<typeof inputSchema> = {
	name: 'get-file-data',
	description:
		'Fetches a wiki file server-side and returns the image inline as a content block, for clients that cannot reach the wiki host (sandboxed or network-restricted) and need the image sent to the model for visual analysis. Returns a scaled rendition sized by width. Files MediaWiki can rasterize (images, SVG, PDF, DjVu) come back as an image; other types (audio, video, arbitrary binaries) error — for those, and for metadata or a download URL, use get-file.',
	inputSchema,
	annotations: {
		title: 'Get file data',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve file data',
	target: (a) => a.title,

	async handle({ title, width, format }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const fileTitle = title.startsWith('File:') ? title : `File:${title}`;
		const effectiveWidth = Math.min(
			width ?? (format === 'text' ? DEFAULT_TEXT_WIDTH : DEFAULT_IMAGE_WIDTH),
			MAX_WIDTH,
		);

		const response = await mwn.request({
			action: 'query',
			titles: fileTitle,
			prop: 'imageinfo',
			iiprop: 'url|size|mime',
			iiurlwidth: effectiveWidth,
			formatversion: '2',
		});

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const page = response.query?.pages?.[0] as ApiPage | undefined;
		if (!page || page.missing) {
			return ctx.format.notFound(`File "${title}" not found`);
		}

		const info: ImageInfo | undefined = page.imageinfo?.[0];
		if (!info) {
			return ctx.format.notFound(`No file info available for "${title}"`);
		}

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
			return ctx.format.invalidInput(
				`File "${title}" (${info.mime ?? 'unknown type'}) cannot be rendered as an image. Use get-file for its download URL.`,
			);
		}

		// Fetch via mwn (the same client that read the metadata) so auth and host
		// trust match: any file imageinfo can describe, this can also download. The
		// URL comes from the trusted configured wiki's own imageinfo, so — unlike a
		// user-supplied URL (add-wiki / discovery, which go through httpFetch's
		// assertPublicDestination guard) — it is intentionally not SSRF-guarded.
		// maxRedirects caps the hop COUNT only; it does NOT address-validate redirect
		// targets. Accepted for v1 given the wiki-derived URL; a host-scoped guard
		// relaxation is a documented future hardening.
		const axiosResponse = await mwn.rawRequest({
			url: fetchUrl,
			method: 'GET',
			responseType: 'arraybuffer',
			maxRedirects: MAX_REDIRECTS,
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios arraybuffer body at this boundary
		const buffer = Buffer.from(axiosResponse.data as ArrayBuffer);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios response headers at this boundary
		const headers = (axiosResponse.headers ?? {}) as Record<string, unknown>;
		const rawContentType = headers['content-type'];
		const responseMime =
			typeof rawContentType === 'string' ? rawContentType.split(';')[0]?.trim() : undefined;

		// The block's mime is the fetched bytes' type (a PDF thumb is image/jpeg),
		// falling back to the original mime for a directly-fetched image. Assert it
		// really is an image before emitting an image block.
		const mimeType =
			responseMime !== undefined && responseMime.startsWith('image/')
				? responseMime
				: isImageMime
					? info.mime
					: undefined;
		if (mimeType === undefined) {
			return ctx.format.invalidInput(
				`Fetched data for "${title}" is not an image (${responseMime ?? info.mime ?? 'unknown type'}). Use get-file for its download URL.`,
			);
		}

		const base64 = buffer.toString('base64');
		const maxBytes = resolveFileDataMaxBytes();
		if (base64.length > maxBytes) {
			return ctx.format.invalidInput(
				`Encoded file data is ${base64.length} bytes, over the ${maxBytes}-byte limit (MCP_FILE_DATA_MAX_BYTES). Request a smaller width.`,
			);
		}

		const wikiKey = ctx.activeWiki.get().key;
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
			format === 'text'
				? { type: 'text', text: base64 }
				: { type: 'image', data: base64, mimeType };

		// No structuredContent: the dispatcher echoes the wiki key by re-wrapping a
		// plain-object structuredContent into a single text block, which would drop
		// the image block. The wiki key is in the caption instead.
		return { content: [caption, payload] };
	},
};
