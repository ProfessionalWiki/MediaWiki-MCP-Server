import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { assertFileExists, FileNotFoundError } from '../wikis/fileExistence.ts';
import { formatEditComment } from '../wikis/utils.ts';
import { uploadFromUrl } from '../wikis/fileUpload.ts';

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
	},
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

		return uploadFromUrl(ctx, mwn, {
			url,
			title,
			text: '',
			params: {
				comment: formatEditComment(ctx, 'update-file-from-url', comment),
				ignorewarnings: true,
			},
		});
	},
};
