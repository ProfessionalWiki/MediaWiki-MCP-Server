import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { errorMessage } from '../errors/isErrnoException.js';
import { assertFileExists, FileNotFoundError } from '../transport/fileExistence.js';
import { fetchFileBytes, shouldRescueToWiki } from '../transport/httpFetch.js';
import { formatEditComment, buildPageUrl } from '../wikis/utils.js';

const inputSchema = {
	url: z.string().url().describe('URL of the file to upload'),
	title: z.string().describe('File title (with or without the "File:" prefix)'),
	comment: z.string().optional().describe('Reason for uploading the new revision'),
} as const;

export const updateFileFromUrl: Tool<typeof inputSchema> = {
	name: 'update-file-from-url',
	description:
		"Fetches a file from a remote web URL and uploads it as a new revision of an existing file, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki's upload log. Replaces the file content (bytes) only; for editing the wikitext on a file's description page, use update-page. Works whether or not the wiki has upload-by-URL enabled: the server retrieves the file and uploads it directly, falling back to wiki-side fetching only when it cannot reach the URL itself. Fails if no file exists at the target title; for the initial upload, use upload-file-from-url.",
	inputSchema,
	annotations: {
		title: 'Update file from URL',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'update file',
	target: (a) => a.title,

	async handle({ url, title, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		try {
			await assertFileExists(mwn, title);
		} catch (error) {
			if (error instanceof FileNotFoundError) {
				return ctx.format.notFound(
					`File "${error.title}" does not exist. To create a new file, use upload-file-from-url.`,
				);
			}
			throw error;
		}

		const baseParams: ApiUploadParams = {
			comment: formatEditComment('update-file-from-url', comment),
			ignorewarnings: true,
		};

		// Server-first: fetch the bytes ourselves (SSRF-guarded, size-capped) and
		// upload via a normal multipart request; fall back to wiki-side fetching
		// only when we can't reach the URL.
		let bytes: Buffer | undefined;
		try {
			bytes = await fetchFileBytes(url);
		} catch (error) {
			if (!shouldRescueToWiki(error)) {
				throw error;
			}
		}

		let data: ApiUploadResponse;
		if (bytes !== undefined) {
			const partName = title.replace(/^File:/, '');
			data = await ctx.edit.submitUploadFromBytes(mwn, bytes, partName, title, '', baseParams);
		} else {
			const params = ctx.edit.applyTags<ApiUploadParams>(baseParams);
			try {
				data = await mwn.uploadFromUrl(url, title, '', params);
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
