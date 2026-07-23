import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { errorMessage } from '../errors/isErrnoException.js';
import { fetchFileBytes, shouldRescueToWiki } from '../transport/httpFetch.js';
import { formatEditComment, buildPageUrl } from '../wikis/utils.js';

const inputSchema = {
	url: z.string().url().describe('URL of the file to upload'),
	title: z.string().describe('File title (with or without the "File:" prefix)'),
	text: z.string().describe('Wikitext on the file page'),
	comment: z.string().optional().describe('Reason for uploading the file'),
} as const;

export const uploadFileFromUrl: Tool<typeof inputSchema> = {
	name: 'upload-file-from-url',
	description:
		"Fetches a file from a remote web URL and uploads it into the wiki's File namespace, returning the resulting file title and URL. The upload appears in the wiki's upload log. Works whether or not the wiki has upload-by-URL enabled: the server retrieves the file and uploads it directly, falling back to wiki-side fetching only when it cannot reach the URL itself. Fails if a file with the target title already exists. To replace an existing file with a new revision, use update-file-from-url.",
	inputSchema,
	annotations: {
		title: 'Upload file from URL',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'upload file',
	target: (a) => a.title,

	async handle({ url, title, text, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const baseParams: ApiUploadParams = {
			comment: formatEditComment(ctx, 'upload-file-from-url', comment),
		};

		// Server-first: fetch the bytes ourselves (SSRF-guarded, size-capped) and
		// upload via a normal multipart request, so the wiki needs no copy-upload
		// config or upload_by_url right.
		let bytes: Buffer | undefined;
		try {
			bytes = await fetchFileBytes(url);
		} catch (error) {
			if (!shouldRescueToWiki(error)) {
				throw error;
			}
			// Reachability/size failure → fall through to wiki-side copy-upload.
		}

		let data: ApiUploadResponse;
		if (bytes !== undefined) {
			const partName = title.replace(/^File:/, '');
			data = await ctx.edit.submitUploadFromBytes(mwn, bytes, partName, title, text, baseParams);
		} else {
			const params = ctx.edit.applyTags<ApiUploadParams>(baseParams);
			try {
				data = await mwn.uploadFromUrl(url, title, text, params);
			} catch (error) {
				const errorText = errorMessage(error);
				if (errorText.includes('copyuploaddisabled')) {
					return ctx.format.error(
						'upstream_failure',
						`Could not retrieve the file from ${url}: the server could not reach it and the wiki has upload-by-URL disabled.`,
						'copyuploaddisabled',
					);
				}
				throw error;
			}
		}

		const imageinfo = (
			data as ApiUploadResponse & {
				imageinfo?: { descriptionurl?: string; url?: string };
			}
		).imageinfo;
		const filename = data.filename ?? title.replace(/^File:/, '');
		return ctx.format.ok({
			filename,
			pageUrl: imageinfo?.descriptionurl ?? (await buildPageUrl(ctx, `File:${filename}`)),
			...(imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {}),
		});
	},
};
