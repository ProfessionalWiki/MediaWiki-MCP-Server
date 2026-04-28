import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { assertFileExists, FileNotFoundError } from '../common/fileExistence.js';
import { formatEditComment, getPageUrl } from '../common/utils.js';

const inputSchema = {
	url: z.string().url().describe( 'URL of the file to upload' ),
	title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
	comment: z.string().optional().describe( 'Reason for uploading the new revision' )
} as const;

export const updateFileFromUrl: Tool<typeof inputSchema> = {
	name: 'update-file-from-url',
	description: 'Fetches a file from a remote web URL and uploads it as a new revision of an existing file, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki\'s upload log. Replaces the file content (bytes) only; for editing the wikitext on a file\'s description page, use update-page. Requires the wiki to have upload-by-URL enabled; if it is disabled, download the file locally and use update-file instead. Fails if no file exists at the target title; for the initial upload, use upload-file-from-url.',
	inputSchema,
	annotations: {
		title: 'Update file from URL',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	} as ToolAnnotations,

	async handle(
		{ url, title, comment },
		ctx: ToolContext
	): Promise<CallToolResult> {
		try {
			await assertFileExists( title );
		} catch ( error ) {
			if ( error instanceof FileNotFoundError ) {
				return ctx.format.notFound(
					`File "${ error.title }" does not exist. To create a new file, use upload-file-from-url.`
				);
			}
			throw error;
		}

		const mwn = await ctx.mwn();
		const baseParams: ApiUploadParams = {
			comment: formatEditComment( 'update-file-from-url', comment ),
			ignorewarnings: true
		};
		const params = ctx.edit.applyTags<ApiUploadParams>( baseParams );

		let data: ApiUploadResponse;
		try {
			data = await mwn.uploadFromUrl( url, title, '', params );
		} catch ( error ) {
			const errorMessage = ( error as Error ).message;
			// Mirror upload-file-from-url: redirect the model away from retrying via URL when
			// the wiki has copyuploads disabled. Routing hint points at the update-file (local)
			// sibling for this tool's update intent.
			if ( errorMessage.includes( 'copyuploaddisabled' ) ) {
				return ctx.format.error(
					'invalid_input',
					'Upload by URL is disabled on this wiki. Download the file locally, then use update-file with the local file path.',
					'copyuploaddisabled'
				);
			}
			throw error;
		}

		const imageinfo = ( data as ApiUploadResponse & {
			imageinfo?: { descriptionurl?: string; url?: string };
		} ).imageinfo;
		const filename = data.filename ?? title.replace( /^File:/, '' );
		return ctx.format.ok( {
			filename,
			pageUrl: imageinfo?.descriptionurl ?? getPageUrl( `File:${ filename }` ),
			...( imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {} )
		} );
	}
};
