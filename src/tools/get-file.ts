import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiPage, ImageInfo } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';

const inputSchema = {
	title: z.string().describe('File title (with or without the "File:" prefix)'),
} as const;

export const getFile: Tool<typeof inputSchema> = {
	name: 'get-file',
	description:
		'Returns metadata for a file (uploader, timestamp, size, MIME type) along with download URLs for the thumbnail, preview, and original. The File: prefix is added automatically if omitted.',
	inputSchema,
	annotations: {
		title: 'Get file',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve file data',
	target: (a) => a.title,

	async handle({ title }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		const fileTitle = title.startsWith('File:') ? title : `File:${title}`;

		const response = await mwn.request({
			action: 'query',
			titles: fileTitle,
			prop: 'imageinfo',
			iiprop: 'url|size|mime|timestamp|user',
			iiurlwidth: 200,
			formatversion: '2',
		});

		const page = response.query?.pages?.[0] as ApiPage | undefined;

		if (!page || page.missing) {
			return ctx.format.notFound(`File "${title}" not found`);
		}

		const info: ImageInfo | undefined = page.imageinfo?.[0];

		if (!info) {
			return ctx.format.notFound(`No file info available for "${title}"`);
		}

		return ctx.format.ok({
			title: page.title,
			descriptionUrl: info.descriptionurl,
			timestamp: info.timestamp,
			user: info.user,
			size: info.size,
			mime: info.mime,
			url: info.url,
			thumbnailUrl: (info as ImageInfo & { thumburl?: string }).thumburl,
		});
	},
};
