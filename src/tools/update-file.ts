import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { assertAllowedPath, UploadValidationError } from '../transport/uploadGuard.js';
import { assertFileExists, FileNotFoundError } from '../transport/fileExistence.js';
import { formatEditComment, getPageUrl } from '../wikis/utils.js';

const inputSchema = {
	filepath: z.string().describe( 'File path on the local disk' ),
	title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
	comment: z.string().optional().describe( 'Reason for uploading the new revision' )
} as const;

export const updateFile: Tool<typeof inputSchema> = {
	name: 'update-file',
	description: 'Uploads a new revision of an existing file from the local disk, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki\'s upload log. Replaces the file content (bytes) only; for editing the wikitext on a file\'s description page, use update-page. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if no file exists at the target title; for the initial upload, use upload-file. To upload a new revision from a remote web address instead of a local path, use update-file-from-url.',
	inputSchema,
	annotations: {
		title: 'Update file',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'update file',
	target: ( a ) => a.title,

	async handle(
		{ filepath, title, comment },
		ctx: ToolContext
	): Promise<CallToolResult> {
		let resolvedPath: string;
		try {
			resolvedPath = await assertAllowedPath( filepath, ctx.uploadDirs.list() );
		} catch ( error ) {
			if ( error instanceof UploadValidationError ) {
				return ctx.format.invalidInput( `Failed to update file: ${ error.message }` );
			}
			throw error;
		}

		const mwn = await ctx.mwn();
		try {
			await assertFileExists( mwn, title );
		} catch ( error ) {
			if ( error instanceof FileNotFoundError ) {
				return ctx.format.notFound(
					`File "${ error.title }" does not exist. To create a new file, use upload-file.`
				);
			}
			throw error;
		}

		const params: ApiUploadParams = {
			comment: formatEditComment( 'update-file', comment ),
			ignorewarnings: true
		};
		const data: ApiUploadResponse = await ctx.edit.submitUpload(
			mwn, resolvedPath, title, '', params
		);

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
