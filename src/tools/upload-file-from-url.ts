import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { fileExists } from '../wikis/fileExistence.ts';
import { formatEditComment } from '../wikis/utils.ts';
import { uploadFromUrl } from '../wikis/fileUpload.ts';

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
	},
	failureVerb: 'upload file',
	target: (a) => a.title,

	async handle({ url, title, text, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// The upload ignores the wiki's warnings, `exists` among them, so the wiki
		// would replace the file rather than refuse.
		if (await fileExists(mwn, title)) {
			return ctx.format.conflict(
				`File "${title}" already exists. To replace it with a new revision, use update-file-from-url.`,
			);
		}

		return uploadFromUrl(ctx, mwn, {
			url,
			title,
			text: text,
			params: {
				comment: formatEditComment(ctx, 'upload-file-from-url', comment),
			},
		});
	},
};
